// A rendered sample of the new report layout, built from synthetic items that mirror
// September's shape. Writes nothing and reads nothing from the database — safe to run before
// regenerating a real report.
//
//   docker exec camp-audit node scripts/report-sample.mjs > /tmp/sample.html
import { renderBoardReportItemsHtml, renderBoardReportItemsText } from '/app/src/reportRender.js';

const report = {
  Title: 'SAMPLE — September 2026', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30',
  ForwardEnd: '2026-10-15', Status: 'draft', ShowHours: false,
  SummaryNotes: 'A sample of the new layout. Figures are illustrative.',
};

const items = [
  // Closed work order, itemized: lines nested, no roll-up sentence, nothing extra.
  { Id: 1, ItemType: 'work_order', ItemId: 60, Section: 'done', Included: true, DisplayMode: 'itemized',
    SnapTitle: "Sump Pump Replacement in Caretaker's", SnapAssetName: "Caretaker's Residence",
    SnapStatus: 'Done', SnapStartDate: '2026-09-23', SnapDate: '2026-09-23',
    SnapCost: 559, SnapProgress: 'Completed: Replace Sump Pump, Install Dehumidifier' },
  { Id: 2, ItemType: 'job_line', ItemId: 82, ParentWorkOrderId: 60, Section: 'done', Included: true,
    SnapTitle: 'Replace Sump Pump', SnapAssetName: "Caretaker's Residence", SnapStatus: 'Done',
    SnapDate: '2026-09-23', SnapCost: 379 },
  { Id: 3, ItemType: 'job_line', ItemId: 83, ParentWorkOrderId: 60, Section: 'done', Included: true,
    SnapTitle: 'Install Dehumidifier', SnapAssetName: "Caretaker's Residence", SnapStatus: 'Done',
    SnapDate: '2026-09-23', SnapCost: 180 },

  // Open work order, itemized: a $0 line, an estimate-only line, and Still to do.
  { Id: 4, ItemType: 'work_order', ItemId: 54, Section: 'done', Included: true, DisplayMode: 'itemized',
    SnapTitle: "Caretaker's Renovations", SnapAssetName: "Caretaker's Residence",
    SnapStatus: 'Reported', SnapStartDate: '2026-09-22', SnapDate: null,
    SnapCost: 800, SnapEstCost: 1540,
    SnapFunding: [{ Source: 'Camp funds', Amount: 1000 }, { Source: 'Personal (Ben)', Amount: 240 }],
    SnapProgress: '52% of ~$1,540 est. complete (4 of 12 lines)',
    SnapOpenLines: ['Paint bedrooms upstairs', 'Clean upstairs', 'Replace lights upstairs'] },
  { Id: 5, ItemType: 'job_line', ItemId: 68, ParentWorkOrderId: 54, Section: 'done', Included: true,
    SnapTitle: 'Remove all wall panels', SnapAssetName: "Caretaker's Residence", SnapStatus: 'Done',
    SnapDate: '2026-09-22', SnapCost: 0 },
  { Id: 6, ItemType: 'job_line', ItemId: 71, ParentWorkOrderId: 54, Section: 'done', Included: true,
    SnapTitle: 'Have wall removed between kitchen and dining room and beam put up to support weight',
    SnapAssetName: "Caretaker's Residence", SnapStatus: 'Done', SnapDate: '2026-09-22', SnapCost: 800 },
  { Id: 7, ItemType: 'job_line', ItemId: 76, ParentWorkOrderId: 54, Section: 'done', Included: true,
    SnapTitle: 'Drywall total cost', SnapAssetName: "Caretaker's Residence", SnapStatus: 'Done',
    SnapDate: '2026-09-22', SnapCost: null, SnapEstCost: 440 },

  // Summary work order: one row, lines swallowed, Still to do still shown because it is open.
  { Id: 8, ItemType: 'work_order', ItemId: 47, Section: 'done', Included: true, DisplayMode: 'summary',
    SnapTitle: 'Front Gate Repair', SnapAssetName: 'Red Gate', SnapStatus: 'Done',
    SnapStartDate: '2026-09-17', SnapDate: '2026-09-17', SnapCost: null, SnapEstCost: 86.18 },
  { Id: 9, ItemType: 'job_line', ItemId: 49, ParentWorkOrderId: 47, Section: 'done', Included: true,
    SnapTitle: 'Replace hinges on gate. Reset gate', SnapAssetName: 'Red Gate', SnapStatus: 'Done',
    SnapDate: '2026-09-17', SnapCost: null, SnapEstCost: 86.18 },

  // Admin tasks: counted as pieces of work, never nested.
  { Id: 10, ItemType: 'admin_task', ItemId: 5, Section: 'admin_work', Included: true,
    SnapTitle: 'Fixed NVR Hard Drive', SnapStatus: 'Done', SnapDate: '2026-09-15', SnapHours: 1.5,
    ReportNote: "Camp's cameras are recording again." },
  { Id: 11, ItemType: 'admin_task', ItemId: 6, Section: 'admin_work', Included: true,
    SnapTitle: 'Internet Service Upgrade/Savings', SnapStatus: 'Done',
    SnapStartDate: '2026-09-16', SnapDate: '2026-09-22', SnapHours: 1 },
];

const aggregates = [
  { GroupKey: 'money', Label: 'Camp funds spent this period', ValueNumeric: 978.07 },
  { GroupKey: 'money', Label: 'Contributed this period', ValueNumeric: 240 },
  { GroupKey: 'savings', Label: 'Recurring savings secured (per year)', ValueNumeric: 3324 },
];

if (process.argv[2] === 'text') {
  console.log(renderBoardReportItemsText({ report, items, aggregates }));
} else {
  console.log(renderBoardReportItemsHtml({ report, items, aggregates }));
}
