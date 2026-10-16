'use strict';
// Synthetic coverage of the historical stage/worklist regressions. No business data.
module.exports = function trackingFixture(today = new Date().toISOString().slice(0, 10)) {
  const date = days => new Date(Date.parse(today + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const complete = { _board: 'import', mode: 'sea', bl_awb: 'FIXTURE-BL', vessel: 'FIXTURE VESSEL',
    voyage: 'FIXTURE-VOYAGE', origin: 'FIXTURE ORIGIN', dest: 'FIXTURE DEST', etd: date(-10) };
  return [
    { po_so: 'FIXTURE-UNSENT', _board: 'import' },
    { ...complete, po_so: 'FIXTURE-NEW-DEPARTURE' },
    { ...complete, po_so: 'FIXTURE-ARRIVED', stage: 'etd', eta: date(-2) },
    { ...complete, po_so: 'FIXTURE-SOON', stage: 'etd', eta: date(2) },
    { ...complete, po_so: 'FIXTURE-BACKLOG', stage: 'etd', eta: date(-100) },
    { ...complete, po_so: 'FIXTURE-CLOSED', stage: 'received', etsActualArrivalDate: date(-5) },
    { ...complete, po_so: 'FIXTURE-MANUAL', stage: 'customs', _stageManual: true },
    { po_so: 'FIXTURE-EXPORT', _board: 'export', stage: 'draft' },
  ];
};
