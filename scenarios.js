/*
 * FairFlow built-in scenarios. All people, organisations and events are
 * synthetic and invented for demonstration. Availability marks:
 *   'preferred'  volunteer asked for this slot
 *   'available'  volunteer can do this slot
 *   'off'        volunteer cannot do this slot (arc is not even built)
 * Runs in the browser (window.FairFlowScenarios) and in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FairFlowScenarios = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Small helper to build availability rows compactly.
  // spec maps shiftId -> 'p' (preferred) | 'a' (available); anything absent is off.
  function avail(spec) {
    const row = {};
    for (const k of Object.keys(spec)) {
      row[k] = spec[k] === 'p' ? 'preferred' : 'available';
    }
    return row;
  }

  const communityKitchen = {
    id: 'kitchen',
    title: 'Community kitchen — festival weekend',
    blurb: 'A neighbourhood kitchen runs six service slots over a festival weekend. Cooks, servers, drivers and one coordinator must cover 16 seats with 10 volunteers.',
    volunteers: [
      { id: 'asha', name: 'Asha Rao', roles: ['cook', 'coordinator'], maxShifts: 3 },
      { id: 'ravi', name: 'Ravi Menon', roles: ['driver'], maxShifts: 2 },
      { id: 'meera', name: 'Meera Iyer', roles: ['server', 'cook'], maxShifts: 3 },
      { id: 'tomas', name: 'Tomas Silva', roles: ['server'], maxShifts: 2 },
      { id: 'priya', name: 'Priya Nair', roles: ['cook'], maxShifts: 2 },
      { id: 'dan', name: 'Dan Okafor', roles: ['driver', 'server'], maxShifts: 3 },
      { id: 'lena', name: 'Lena Hoff', roles: ['server'], maxShifts: 2 },
      { id: 'kiran', name: 'Kiran Bose', roles: ['cook', 'driver'], maxShifts: 2 },
      { id: 'sofia', name: 'Sofia Marino', roles: ['server', 'coordinator'], maxShifts: 2 },
      { id: 'jamal', name: 'Jamal Reed', roles: ['driver'], maxShifts: 1 },
    ],
    shifts: [
      { id: 'fri-prep', name: 'Friday prep', slot: 'Fri 16:00–19:00', role: 'cook', capacity: 3 },
      { id: 'sat-cook', name: 'Saturday kitchen', slot: 'Sat 08:00–12:00', role: 'cook', capacity: 3 },
      { id: 'sat-serve', name: 'Saturday service', slot: 'Sat 12:00–15:00', role: 'server', capacity: 4 },
      { id: 'sat-deliver', name: 'Saturday deliveries', slot: 'Sat 13:00–16:00', role: 'driver', capacity: 2 },
      { id: 'sun-cook', name: 'Sunday kitchen', slot: 'Sun 08:00–12:00', role: 'cook', capacity: 2 },
      { id: 'sun-coord', name: 'Sunday coordination', slot: 'Sun 09:00–13:00', role: 'coordinator', capacity: 2 },
    ],
    availability: {
      asha: avail({ 'fri-prep': 'p', 'sat-cook': 'a', 'sun-cook': 'a', 'sun-coord': 'p' }),
      ravi: avail({ 'sat-deliver': 'p', 'sat-serve': 'a' }),
      meera: avail({ 'fri-prep': 'a', 'sat-serve': 'p', 'sun-cook': 'a' }),
      tomas: avail({ 'sat-serve': 'p', 'fri-prep': 'a' }),
      priya: avail({ 'fri-prep': 'p', 'sat-cook': 'p' }),
      dan: avail({ 'sat-deliver': 'a', 'sat-serve': 'a', 'sun-cook': 'a' }),
      lena: avail({ 'sat-serve': 'a', 'sun-coord': 'a' }),
      kiran: avail({ 'sat-cook': 'a', 'sat-deliver': 'p', 'sun-cook': 'a' }),
      sofia: avail({ 'sun-coord': 'p', 'sat-serve': 'a' }),
      jamal: avail({ 'sat-deliver': 'a' }),
    },
  };

  const animalShelter = {
    id: 'shelter',
    title: 'Animal shelter — adoption week',
    blurb: 'An adoption week needs handlers, front-desk volunteers and cleaners across seven slots. Demand for handlers outstrips what the five qualified people can cover, so the solver has to show the bottleneck honestly.',
    volunteers: [
      { id: 'nina', name: 'Nina Petrov', roles: ['handler'], maxShifts: 2 },
      { id: 'omar', name: 'Omar Haddad', roles: ['handler', 'desk'], maxShifts: 2 },
      { id: 'grace', name: 'Grace Lin', roles: ['desk'], maxShifts: 3 },
      { id: 'leo', name: 'Leo Costa', roles: ['cleaner'], maxShifts: 2 },
      { id: 'mia', name: 'Mia Tanaka', roles: ['handler'], maxShifts: 1 },
      { id: 'sam', name: 'Sam Whitfield', roles: ['desk', 'cleaner'], maxShifts: 2 },
      { id: 'ira', name: 'Ira Kulkarni', roles: ['handler'], maxShifts: 1 },
      { id: 'noah', name: 'Noah Berg', roles: ['cleaner'], maxShifts: 2 },
      { id: 'zoe', name: 'Zoe Alvarez', roles: ['desk'], maxShifts: 2 },
      { id: 'eli', name: 'Eli Turner', roles: ['cleaner', 'handler'], maxShifts: 1 },
      { id: 'ruth', name: 'Ruth Adler', roles: ['desk'], maxShifts: 1 },
      { id: 'ken', name: 'Ken Mori', roles: ['cleaner'], maxShifts: 2 },
    ],
    shifts: [
      { id: 'mon-handle', name: 'Monday handling', slot: 'Mon 10:00–13:00', role: 'handler', capacity: 2 },
      { id: 'tue-desk', name: 'Tuesday front desk', slot: 'Tue 10:00–14:00', role: 'desk', capacity: 2 },
      { id: 'wed-handle', name: 'Wednesday handling', slot: 'Wed 10:00–13:00', role: 'handler', capacity: 3 },
      { id: 'thu-clean', name: 'Thursday deep clean', slot: 'Thu 09:00–12:00', role: 'cleaner', capacity: 3 },
      { id: 'fri-desk', name: 'Friday front desk', slot: 'Fri 10:00–14:00', role: 'desk', capacity: 2 },
      { id: 'sat-handle', name: 'Adoption day handling', slot: 'Sat 09:00–15:00', role: 'handler', capacity: 3 },
      { id: 'sat-clean', name: 'Adoption day cleanup', slot: 'Sat 15:00–18:00', role: 'cleaner', capacity: 2 },
    ],
    availability: {
      nina: avail({ 'mon-handle': 'p', 'wed-handle': 'a', 'sat-handle': 'a' }),
      omar: avail({ 'mon-handle': 'a', 'sat-handle': 'p', 'tue-desk': 'a' }),
      grace: avail({ 'tue-desk': 'p', 'fri-desk': 'p' }),
      leo: avail({ 'thu-clean': 'p', 'sat-clean': 'a' }),
      mia: avail({ 'sat-handle': 'p', 'wed-handle': 'a' }),
      sam: avail({ 'tue-desk': 'a', 'thu-clean': 'a', 'fri-desk': 'a' }),
      ira: avail({ 'wed-handle': 'p', 'sat-handle': 'a', 'mon-handle': 'a' }),
      noah: avail({ 'thu-clean': 'a', 'sat-clean': 'p' }),
      zoe: avail({ 'fri-desk': 'p', 'tue-desk': 'a' }),
      eli: avail({ 'sat-handle': 'a', 'sat-clean': 'a' }),
      ruth: avail({ 'fri-desk': 'a' }),
      ken: avail({ 'thu-clean': 'p', 'sat-clean': 'a' }),
    },
  };

  const conferenceDesk = {
    id: 'conference',
    title: 'Student conference — welcome weekend',
    blurb: 'A student-run conference needs greeters, tech support and runners. One evening slot only has two qualified people available, which makes it a clean demo of the unfilled-slot explanation.',
    volunteers: [
      { id: 'anika', name: 'Anika Shah', roles: ['greeter', 'runner'], maxShifts: 2 },
      { id: 'ben', name: 'Ben Novak', roles: ['tech'], maxShifts: 2 },
      { id: 'chloe', name: 'Chloe Dubois', roles: ['greeter'], maxShifts: 2 },
      { id: 'dev', name: 'Dev Patil', roles: ['tech', 'runner'], maxShifts: 1 },
      { id: 'emma', name: 'Emma Rossi', roles: ['runner'], maxShifts: 2 },
      { id: 'finn', name: 'Finn Walsh', roles: ['greeter', 'tech'], maxShifts: 2 },
      { id: 'gia', name: 'Gia Nguyen', roles: ['runner'], maxShifts: 1 },
      { id: 'hugo', name: 'Hugo Serrano', roles: ['greeter'], maxShifts: 1 },
    ],
    shifts: [
      { id: 'fri-reg', name: 'Friday registration', slot: 'Fri 14:00–18:00', role: 'greeter', capacity: 2 },
      { id: 'fri-av', name: 'Friday AV setup', slot: 'Fri 15:00–18:00', role: 'tech', capacity: 2 },
      { id: 'sat-door', name: 'Saturday doors', slot: 'Sat 08:00–10:00', role: 'greeter', capacity: 2 },
      { id: 'sat-tech', name: 'Saturday stage tech', slot: 'Sat 09:00–13:00', role: 'tech', capacity: 2 },
      { id: 'sat-run', name: 'Saturday runners', slot: 'Sat 10:00–14:00', role: 'runner', capacity: 2 },
      { id: 'sat-late', name: 'Saturday late desk', slot: 'Sat 18:00–21:00', role: 'greeter', capacity: 2 },
    ],
    availability: {
      anika: avail({ 'fri-reg': 'p', 'sat-door': 'a', 'sat-run': 'a' }),
      ben: avail({ 'fri-av': 'p', 'sat-tech': 'a' }),
      chloe: avail({ 'fri-reg': 'a', 'sat-door': 'p' }),
      dev: avail({ 'sat-tech': 'p', 'sat-run': 'a' }),
      emma: avail({ 'sat-run': 'p', 'fri-reg': 'a' }),
      finn: avail({ 'sat-tech': 'a', 'sat-door': 'a', 'fri-av': 'a' }),
      gia: avail({ 'sat-run': 'a' }),
      hugo: avail({ 'sat-late': 'a', 'sat-door': 'a' }),
    },
  };

  const list = [communityKitchen, animalShelter, conferenceDesk];

  function clone(scenario) {
    return JSON.parse(JSON.stringify(scenario));
  }
  function byId(id) {
    const found = list.find((s) => s.id === id);
    return found ? clone(found) : null;
  }

  return { list, byId, clone };
});
