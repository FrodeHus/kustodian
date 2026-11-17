# Log cost estimator

Estimates what your logs cost in a Log Analytics workspace with Microsoft Sentinel, and what Defender XDR tables or a new
custom table would cost if you sent them there. Every price is a workbook parameter: the defaults are East US list prices in
USD (November 2026). Set your own region's or agreement's prices under **Parameters**; prices and retention settings are
remembered on this computer. **Currency** is only a label: enter the prices in that currency.

## What it shows

**Current cost** reads the workspace's `Usage` table over the whole UTC days in the time range:

- Billable GB per day, and the estimated monthly ingestion, retention and total cost.
- Per table: GB per day, its plan (Analytics, Basic or Auxiliary), its share, and its monthly cost. **Tables** narrows this to
  the tables you pick; with none picked, all billable tables count. A table that logs only some days is still averaged over
  the whole range.
- The daily volume of the ten largest tables.
- Pay-as-you-go against each Sentinel commitment tier, for the workspace's Analytics volume. The tiers are East US prices
  scaled by your Analytics price ÷ 4.30, an approximation, as regional tier discounts differ.

**Defender XDR if streamed** measures the Defender XDR tables in advanced hunting over the last 7 days with
`estimate_data_size()`, scaled by a factor (0.8 by default, as the estimate runs above the billed size), and prices them as
Analytics ingestion, with a total. It runs on your primary workspace. It counts every table, including ones you already
stream, which are on **Current cost** too, so don't add those twice. On a very large tenant the measurement can time out.

**New custom table** estimates a table you haven't connected yet: from events per day × bytes per event (× 0.75, as billed
size is about a quarter smaller than the raw JSON), or from a similar Analytics table you already collect (its billed bytes
per row yesterday). Only Analytics tables are offered, because scanning a Basic or Auxiliary table is billed.

## How it calculates

- Monthly ingestion = GB per day × 30 × the plan's price per GB.
- Monthly retention = GB per day × (retention days − free days, never below zero) × retention price per GB-month. Free days
  are the parameter (90 with Sentinel) for Analytics and 30 for Basic and Auxiliary. This assumes the extra days are
  long-term retention ($0.02 per GB-month in East US). Analytics (interactive) retention beyond the free days costs more
  (about $0.10 per GB-month in East US): set the retention price to that if you extended it.
- A commitment tier costs its daily price plus any volume over the tier at the tier's own price per GB.

## Not covered

- The Defender for Servers Plan 2 (500 MB per server per day) and Microsoft 365 E5 (5 MB per user per day) allowances. They
  are taken off on the bill, so tables they cover show higher here.
- The 5 GB per month Log Analytics free grant, and query and search charges for Basic and Auxiliary tables.
- The Sentinel data lake meters, dedicated clusters, search jobs and restores.
- Taxes and negotiated discounts.

## What it needs

- Reader or Log Analytics Reader on the workspace, for **Current cost** and **New custom table**.
- `ThreatHunting.Read.All`, for **Defender XDR if streamed**.

Pick the workspace with the **Workspace** parameter after installing: a solution never carries one.
