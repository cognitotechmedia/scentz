# Scentz

Billing, stock and franchise management for a fragrance house. Node.js (22.5+) with the built-in SQLite. No packages to install.

## Run it

```
npm start
```

Open http://localhost:3000. On the first run the server creates the HQ administrator and prints the password once:

```
username: admin
password: <generated>
```

Set your own with `ADMIN_PASSWORD=... npm start` on the very first run. Change it later under **Store settings**.

| Setting | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `HOST` | 127.0.0.1 | Set `0.0.0.0` so other devices can connect. Put it behind HTTPS |
| `DATA_DIR` | `./data` | Where the database file lives |
| `COOKIE_SECURE` | off | Set `1` when serving over HTTPS |

## Data and backups

Everything is in one file: `data/velour.db` (plus `-wal`/`-shm` while running).

- **Automatic:** the server saves a dated copy to `data/backups/` once a day and keeps the last 14.
- **Manual:** HQ administrators can download a backup any time from **Store settings**. It contains every outlet's data and the password hashes, so store it somewhere safe. Copy the automatic ones off the machine too, since a backup on the same disk doesn't survive a disk failure.
- **Restore:** stop the server, replace `data/velour.db` with the backup file (delete `velour.db-wal` and `velour.db-shm` if present), then start it again.

Bill dates use the server's time zone, so run it with the shop's (e.g. `TZ=Asia/Kolkata`).

## Line-by-line entry

Purchases, Opening stock and Stock verification use a line grid. In the **Item code** cell type an item code (M001), scan or type an EAN/barcode, or type part of a name, then press Enter. Enter moves across the row and starts the next row after the last cell. Arrow keys move between rows. Function keys: F3 delete row, F5 supplier (purchases), F6 save, F12 clear. Each stock item has an editable unique code and an optional unique EAN, set in the item master.

### Opening stock

Press Enter on the cost cell to save that item at once and open the next line; each line shows Saved or Unsaved, and Save stores the whole sheet and opens a fresh one. To load many items, download the template (.xlsx or .csv), fill it in and use Import Excel / CSV. Rows are matched by item code, then EAN, then name; a preview shows what will be imported and what needs attention before anything is saved. The Opening stock tab under Reports lists what was entered for each outlet.

## Price lists and customer types

Every billing catalogue product has three prices: **retail**, **wholesale** and **franchise**. Stock items can also have wholesale and franchise selling prices. HQ sets all of them under **Price update** (cost and margin are shown next to each price). On **New bill**, choose Retail, Wholesale or Franchise. Wholesale and franchise bills can mix billing catalogue products and stock items; the billed stock quantity is deducted in its own unit. Retail billing continues to show the billing catalogue only. Customers are retail, wholesale or franchise: people added from the retail billing screen are retailers; wholesalers and franchisees are added in the **Customer book**, where any customer can be edited to change their type. A bill is priced from its customer's list (the server does the pricing, so the screen cannot override it) and keeps the buyer's GSTIN and address. Franchise invoices are numbered in their own `FRN` series. Bills already made never change when prices or customer types are edited.

## Day closing

At the end of each day, open **Day closing** (admin and manager). The system totals what moved that day by payment mode. Enter the opening cash (it starts at the float kept the night before), count the drawer (or use the notes counter), and type the card machine and UPI/bank totals. Differences are shown at once and need a note. **Keep for change tomorrow** (₹500 or ₹1,000, or any amount) becomes the next day's opening cash; the rest is the cash to deposit. Cash expected = opening + cash received − refunds − cash paid out (expenses, suppliers). Card, UPI and bank are checked against what was collected less refunds. A printable closing report is saved with each closing, and a sale made after closing is flagged. HQ can reopen a closed day.

Below the tally, **Day's sales against the money you submitted** sets the two side by side: what was billed, less returns, less what stayed on credit or was paid in points, plus dues collected from earlier bills, is the money that should have come in. Your count (cash counted − opening cash + cash paid out for expenses and suppliers, plus the card, UPI and bank totals) is compared with it, with expenses paid listed by mode. It updates as you type and is saved and printed with the closing.

## Loyalty points

HQ switches the program on under **Customers → Loyalty program** and sets: how many points a customer earns per ₹ spent, which customer types earn (retail, wholesale, franchise), whether points are earned only on bills paid in full, what one point is worth, and the redeem conditions: minimum points, minimum bill amount, the largest share of a bill points can pay, and how many days until points expire. On the billing screen a customer with points shows their balance and a **redeem** box (with **Use max**); points pay part of the bill and the rest is taken as cash, card or UPI. Points are earned on what the customer really pays. A return gives back points that paid for the returned goods and takes back points earned on them. Staff can add or remove points with a reason (**Customers → Points**), and the history of every point is kept. Points belong to the outlet where they were earned.

## Salesmen

Each outlet keeps a list of salesmen (New bill → Manage). Pick the salesman on a bill and the sale is credited to them; the last one used stays selected. Salesmen can be renamed or switched off without losing their past sales. **Reports → Salesman-wise** shows bills, items, sales, returns, net sales, average bill and share per salesman, plus every bill with its salesman (CSV export included). Returns come off the salesman who made the original bill.

## Printing

Bills, credit notes and receipts print on a full sheet (A4), or in a narrow layout for a **3 inch (80 mm)** or **2 inch (58 mm)** receipt roll. Choose the paper next to the Print button, or under Store settings. The choice is remembered on that computer. In the browser print window pick the receipt printer and set margins to None. Ingredients of custom blends are never printed.

## Payment at the counter

On the billing screen, cash received can be more than the bill: the balance to return is shown, and only the bill amount is recorded as income. Card, UPI and bank amounts can never be more than the bill. **Split payment** pays one bill in up to four parts (for example part cash, part UPI); the last line fills in what is left as you type.

## Receipts, payments and franchise invoices

**Receipts & payments** records money received from credit customers and paid to suppliers. Each is a numbered voucher (`RCT` / `PAY`) applied to one or more unpaid bills, with a printable document; billers can take receipts but not make payments. The Receive and Pay buttons elsewhere create the same vouchers.

**Franchise invoices as purchases:** HQ links the franchise customer to a specific receiving outlet in the Customer book. The GSTIN must match that outlet. On the franchisee's **Purchases** screen the invoice appears under "Invoices raised on your outlet"; **Load into purchase** books it in one step. Stock-counted items are added to the outlet's stock at the cost before GST, the GST is kept as part of the amount owed to HQ, and the invoice can only be loaded once. Pay HQ afterwards from Receipts & payments.

## Roles

- **HQ administrator**: sees every outlet, switches between them, manages the catalog, prices and GST, outlets, users, stock transfers and royalty.
- **Outlet manager**: works only inside their own outlet (billing, purchases, customers, opening stock, receiving transfers, reports). Prices and GST always come from HQ; the server recalculates every bill.
- **Biller**: a counter login for one outlet. Can make bills, add customers, take payments on bills and view sales, customers and the product list. Cannot see cost prices, purchases, expenses, reports or stock control, cannot make returns, and cannot change settings other than their own password. Create billers under Outlets & users.

## Tests

```
npm test
```

Starts the server on a temporary database and checks the API end to end, including permissions.

## Searching products

The **Products** screen has a search box: type any part of a name, item code, barcode or type (several words must all match). The buttons beside it narrow the list to **Stock items**, **Billing catalog**, or **Low & out of stock**. Headings show how many of the total match, and **Esc** clears the search. Billers can search too.


## Version 2.1 controls

Bill requests are recoverable and cannot be replayed into duplicate sales. Royalty rates are saved per invoice. Linked franchise payments and returns update both outlets in one transaction. Store settings includes audit history, historical closing snapshots, and franchise reconciliation. Password and role changes revoke old sessions. Existing data upgrades automatically with a pre-upgrade recovery backup; older royalty rates are marked as baselines because past rate changes were not recorded. Run `npm test` for the API and controls regression suites.

## Bulk stock-item import

On **Products**, administrators can choose **Import stock items** for Excel or CSV uploads of up to 500 new stock items. Download the template, remove its example row, and enter `name`, `type` (Attar stock, Raw material, or Packaging), and `unit` (ml or pcs). Optional fields are `code`, `ean` (keep barcodes as text), and `alertMl` (minimum stock in the chosen unit; blank defaults to 50 ml or 5 pcs).

The preview validates the entire batch without saving. Duplicate names, codes, barcodes, and invalid values prevent the whole batch from being imported. Stock items appear in inventory and do not create billing products. Enter opening quantities and costs through **Opening stock** after importing. **Import billing products** remains available separately. No database migration is required.
