/*
 * FairFlow planning helpers: scenario validation (JSON import), slot-label
 * parsing, time-overlap warnings and roster duplication.
 *
 * Time-overlap design (deliberately a warning layer, never a constraint):
 * the solver treats slot labels as free text. This module parses the labels
 * it recognises into week-minute intervals and warns when one volunteer is
 * assigned to two shifts whose intervals overlap. Labels it cannot parse,
 * or cannot compare (a day label against a day-less one, or an overnight
 * range with no day), are reported as UNCHECKED: the absence of a conflict
 * warning never means "no clash".
 *
 * Recognised label grammar (anything else parses to null):
 *   [day] START SEP END
 *   day  : mon..sun, full or 3+ letter English names, optional comma
 *   START/END: "H:MM" (24h) or "H[:MM] AM/PM"
 *   SEP  : "-", "–", "—" or "to"
 * Overnight: when END <= START the range is read as crossing midnight
 * (END += 24h). Day-labelled overnight ranges are compared in absolute
 * week minutes, so "Sat 22:00–02:00" correctly overlaps "Sun 01:00–03:00".
 *
 * Pure module: runs in the browser (window.FairFlowPlan) and in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FairFlowPlan = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var DAY_WORDS = {
    mon: 0, monday: 0,
    tue: 1, tues: 1, tuesday: 1,
    wed: 2, wednesday: 2,
    thu: 3, thur: 3, thurs: 3, thursday: 3,
    fri: 4, friday: 4,
    sat: 5, saturday: 5,
    sun: 6, sunday: 6,
  };

  // One time token: "08:00", "8:00", "9am", "9:30 PM".
  var TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*([aApP][mM])?';
  var RANGE_RE = new RegExp(
    '^(?:([a-zA-Z]{3,9})[,]?\\s+)?' + // optional day word
    TIME + '\\s*(?:-|–|—|to)\\s*' + TIME + '\\s*$'
  );

  function toMinutes(h, m, ap) {
    var hour = Number(h);
    var mins = m ? Number(m) : 0;
    if (mins > 59) return null;
    if (ap) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12;
      if (ap.toLowerCase() === 'pm') hour += 12;
    } else if (hour > 23) {
      return null;
    }
    return hour * 60 + mins;
  }

  // parseSlot('Sat 08:00–12:00') -> { day: 5, start: 480, end: 720, overnight: false }
  // parseSlot('Fri 22:00–02:00') -> { day: 4, start: 1320, end: 1560, overnight: true }
  // parseSlot('morning') -> null
  function parseSlot(label) {
    if (typeof label !== 'string') return null;
    var m = RANGE_RE.exec(label.trim());
    if (!m) return null;
    var day = null;
    if (m[1]) {
      var key = m[1].toLowerCase();
      if (!(key in DAY_WORDS)) return null; // leading word that is not a day: not our grammar
      day = DAY_WORDS[key];
    }
    var start = toMinutes(m[2], m[3], m[4]);
    var end = toMinutes(m[5], m[6], m[7]);
    if (start === null || end === null) return null;
    var overnight = false;
    if (end <= start) { end += 1440; overnight = true; }
    return { day: day, start: start, end: end, overnight: overnight };
  }

  function weekRange(p) {
    // Absolute week minutes; only meaningful for day-labelled parses.
    return [p.day * 1440 + p.start, p.day * 1440 + p.end];
  }

  // Compare two parsed slots. Returns:
  //   { overlap: true }                     proven clash
  //   { overlap: false }                    proven no clash
  //   { overlap: null, reason: '...' }      cannot tell - must be reported as unchecked
  function compareSlots(pa, pb) {
    if (!pa || !pb) return { overlap: null, reason: 'a slot label is not in a recognised day/time format' };
    if ((pa.day === null) !== (pb.day === null)) {
      return { overlap: null, reason: 'one label names a day and the other does not, so they cannot be compared' };
    }
    if (pa.day === null && pb.day === null) {
      if (pa.overnight || pb.overnight) {
        return { overlap: null, reason: 'an overnight range without a day is ambiguous' };
      }
      return { overlap: pa.start < pb.end && pb.start < pa.end };
    }
    var a = weekRange(pa), b = weekRange(pb);
    return { overlap: a[0] < b[1] && b[0] < a[1] };
  }

  // overlapCheck(scenario, assignments) -> { conflicts: [...], unchecked: [...] }
  // assignments: [{ vol, shift }] as produced by the model solution.
  // conflicts: proven overlapping pairs; unchecked: pairs that could not be
  // evaluated (never silently treated as conflict-free).
  function overlapCheck(scenario, assignments) {
    var shiftById = {};
    scenario.shifts.forEach(function (s) { shiftById[s.id] = s; });
    var volById = {};
    scenario.volunteers.forEach(function (v) { volById[v.id] = v; });
    var byVol = {};
    assignments.forEach(function (a) {
      if (!byVol[a.vol]) byVol[a.vol] = [];
      if (byVol[a.vol].indexOf(a.shift) === -1) byVol[a.vol].push(a.shift);
    });
    var conflicts = [];
    var unchecked = [];
    Object.keys(byVol).forEach(function (volId) {
      var ids = byVol[volId];
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          var sa = shiftById[ids[i]], sb = shiftById[ids[j]];
          if (!sa || !sb) continue;
          var verdict = compareSlots(parseSlot(sa.slot), parseSlot(sb.slot));
          var entry = {
            volId: volId,
            volName: volById[volId] ? volById[volId].name : volId,
            a: { id: sa.id, name: sa.name, slot: sa.slot },
            b: { id: sb.id, name: sb.name, slot: sb.slot },
          };
          if (verdict.overlap === true) conflicts.push(entry);
          else if (verdict.overlap === null) {
            entry.reason = verdict.reason;
            unchecked.push(entry);
          }
        }
      }
    });
    return { conflicts: conflicts, unchecked: unchecked };
  }

  /* ---------- scenario validation (JSON import) ---------- */

  var MAX_PEOPLE = 200;
  var MAX_SHIFTS = 200;
  var MAX_NAME = 90;
  var AVAIL_VALUES = { off: 1, available: 1, preferred: 1 };

  function slugify(text, taken) {
    var base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'roster';
    var id = base;
    var n = 2;
    while (taken && taken[id]) { id = base + '-' + n; n++; }
    if (taken) taken[id] = true;
    return id;
  }

  function cleanString(value, maxLen) {
    if (typeof value !== 'string') return null;
    var s = value.trim().slice(0, maxLen || MAX_NAME);
    return s.length ? s : null;
  }

  function clampInt(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    return Math.max(min, Math.min(max, n));
  }

  // validateScenario(raw) -> { ok, errors: [...], warnings: [...], scenario? }
  // Repairs what is safely repairable (with warnings); rejects on anything
  // that would change the meaning of the roster. Never throws.
  function validateScenario(raw) {
    var errors = [];
    var warnings = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['File must contain a JSON object with volunteers, shifts and availability.'], warnings: warnings };
    }
    if (!Array.isArray(raw.volunteers)) errors.push('"volunteers" must be an array.');
    if (!Array.isArray(raw.shifts)) errors.push('"shifts" must be an array.');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };
    if (raw.volunteers.length > MAX_PEOPLE) errors.push('Too many volunteers (max ' + MAX_PEOPLE + ').');
    if (raw.shifts.length > MAX_SHIFTS) errors.push('Too many shifts (max ' + MAX_SHIFTS + ').');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    var title = cleanString(raw.title, MAX_NAME) || 'Imported roster';
    var taken = {};

    var volunteers = [];
    raw.volunteers.forEach(function (item, i) {
      var where = 'volunteer ' + (i + 1);
      if (!item || typeof item !== 'object') { errors.push(where + ': not an object.'); return; }
      var name = cleanString(item.name);
      if (!name) { errors.push(where + ': missing a name.'); return; }
      var roles = Array.isArray(item.roles)
        ? item.roles.map(function (r) { return cleanString(r, 40); }).filter(Boolean)
        : [];
      if (roles.length === 0) { errors.push(where + ' ("' + name + '"): needs at least one role.'); return; }
      var maxShifts = clampInt(item.maxShifts, 1, 10);
      if (maxShifts === null) { maxShifts = 2; warnings.push(where + ' ("' + name + '"): invalid shift limit, set to 2.'); }
      else if (maxShifts !== Number(item.maxShifts)) warnings.push(where + ' ("' + name + '"): shift limit clamped to ' + maxShifts + '.');
      volunteers.push({ id: slugify(item.id || name, taken), name: name, roles: roles, maxShifts: maxShifts });
    });

    var shifts = [];
    raw.shifts.forEach(function (item, i) {
      var where = 'shift ' + (i + 1);
      if (!item || typeof item !== 'object') { errors.push(where + ': not an object.'); return; }
      var name = cleanString(item.name);
      if (!name) { errors.push(where + ': missing a name.'); return; }
      var role = cleanString(item.role, 40);
      if (!role) { errors.push(where + ' ("' + name + '"): missing a role.'); return; }
      var slot = cleanString(item.slot, 60);
      if (!slot) { slot = 'TBD'; warnings.push(where + ' ("' + name + '"): no time label, set to "TBD".'); }
      var capacity = clampInt(item.capacity, 1, 12);
      if (capacity === null) { capacity = 1; warnings.push(where + ' ("' + name + '"): invalid seat count, set to 1.'); }
      else if (capacity !== Number(item.capacity)) warnings.push(where + ' ("' + name + '"): seat count clamped to ' + capacity + '.');
      shifts.push({ id: slugify(item.id || name, taken), name: name, slot: slot, role: role, capacity: capacity });
    });

    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    var volIds = {}; volunteers.forEach(function (v) { volIds[v.id] = true; });
    var shiftIds = {}; shifts.forEach(function (s) { shiftIds[s.id] = true; });
    var availability = {};
    var dropped = 0;
    if (raw.availability && typeof raw.availability === 'object' && !Array.isArray(raw.availability)) {
      Object.keys(raw.availability).forEach(function (volId) {
        if (volId === '__proto__' || !volIds[volId]) { dropped++; return; }
        var row = raw.availability[volId];
        if (!row || typeof row !== 'object' || Array.isArray(row)) { dropped++; return; }
        var clean = {};
        Object.keys(row).forEach(function (shiftId) {
          if (shiftId === '__proto__' || !shiftIds[shiftId]) { dropped++; return; }
          var value = row[shiftId];
          if (!AVAIL_VALUES[value]) { dropped++; return; }
          if (value !== 'off') clean[shiftId] = value;
        });
        if (Object.keys(clean).length) availability[volId] = clean;
      });
    }
    if (dropped > 0) warnings.push(dropped + ' availability entr' + (dropped === 1 ? 'y was' : 'ies were') + ' dropped (unknown person, shift or value).');

    return {
      ok: true,
      errors: [],
      warnings: warnings,
      scenario: { id: slugify(title, {}), title: title, blurb: cleanString(raw.blurb, 240) || '', volunteers: volunteers, shifts: shifts, availability: availability },
    };
  }

  // Deep clone with a new id/title. Slot labels are copied unchanged: the
  // coordinator edits the new week’s times themselves.
  function duplicateRoster(scenario, title) {
    var copy = JSON.parse(JSON.stringify(scenario));
    copy.title = cleanString(title, MAX_NAME) || (scenario.title + ' (copy)');
    copy.id = slugify(copy.title, {});
    return copy;
  }

  return {
    DAY_WORDS: DAY_WORDS,
    parseSlot: parseSlot,
    compareSlots: compareSlots,
    overlapCheck: overlapCheck,
    validateScenario: validateScenario,
    duplicateRoster: duplicateRoster,
    slugify: slugify,
  };
});
