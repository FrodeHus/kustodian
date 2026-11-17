# Log cost estimator solution

Status: approved 2026-11-17. Uses parameter choices from a query (2026-11-13) and the workbook workspace parameter (2026-11-16).

## Why

People running Microsoft Sentinel and Defender XDR want to know what their logs cost today, per table, and what a new source
would cost before they connect it. Microsoft's tools either show only the bill or need volumes typed into a calculator.

## Goals

- One Community Solution, `log-cost`, with one tabbed workbook. Prices, retention and factors are workbook parameters with
  East US list prices (USD, November 2026) as defaults.
- **Current cost** (Log Analytics `Usage`): billable GB per day, monthly ingestion cost by table plan (Analytics, Basic,
  Auxiliary), retention cost beyond the free days, daily trend of the top tables, and a comparison with Sentinel commitment
  tiers. Respects a Tables parameter whose choices come from `Usage`.
- **Defender XDR not yet streamed** (advanced hunting, primary workspace, last 7 days): `estimate_data_size(*)` per table ×
  a calibration factor, priced as Analytics ingestion.
- **New custom table**: events per day × bytes per event × 0.75, or a similar existing table's billed bytes per row, priced
  on all three plans.

## Non-goals

- The Sentinel data lake meters, dedicated clusters, search jobs and restores.
- Subtracting the Defender for Servers and Microsoft 365 E5 allowances (applied only at billing): the workbook says so.
- Reading the actual bill (Cost Management).

## Formulas

- GB per day = sum(`Usage.Quantity`) / 1000 over full UTC days in the time range ÷ the number of those days.
- Monthly ingestion = GB/day × 30 × the plan's price per GB (`Usage.Plan`; empty means Analytics).
- Monthly retention = GB/day × max(0, retention days − free days) × retention price per GB-month. Free days: the parameter
  (90 with Sentinel) for Analytics, 30 for Basic and Auxiliary.
- Commitment tier per day = tier price + max(0, Analytics GB/day − tier GB) × tier price ÷ tier GB; tier prices are the East
  US Sentinel simplified prices scaled by (Analytics price ÷ 4.30). Pay-as-you-go = Analytics GB/day × Analytics price.
- XDR GB/day = sum(`estimate_data_size(*)`) per table over 7 days ÷ 7 ÷ 10⁹ × the factor (default 0.8; the estimate runs
  10–25% above billed size).

## Design

- Parameters: Workspace (workspace), TimeRange (timespan, the workbook timespan, 30d), Tables (list, several, All, choices
  from `Usage`; none picked means all), Currency (text, shown in headings), PriceAnalytics 4.30, PriceBasic 1.00,
  PriceAuxiliary 0.15, RetentionDays 90, FreeRetentionDays 90, RetentionPrice 0.02, XdrFactor 0.8, EventsPerDay 1000000,
  BytesPerEvent 500, SimilarTable (text, choices from `Usage`, required: only its widget waits for it).
- XDR widgets fix TimeRange to 7d and Workspace to empty (primary workspace) in their own entries. The tables are read with
  `union isfuzzy=true`, so a tenant without a product's tables still gets the others.
- Workbook version 2 (tabs); `minAppVersion` 1.2.0.

## Left to the builder

Widget layout, titles and the README.
