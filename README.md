# RoaDo Load Optimizer

A browser-based truck load optimiser and order planner. It packs items into a vehicle in 3D with stacking norms, multi-drop unloading order (LIFO) and category co-loading rules. It also clubs orders into trips and picks owned or hired (market) vehicles. When a load is too big for any single vehicle, it splits the load across as few trucks as possible.

It runs fully offline. You can use it as a single executable for Windows, macOS or Linux, or just open `index.html`.

![tabs](https://img.shields.io/badge/tabs-Load%20Optimizer%20·%20Order%20Planning%20·%20Load%20Sequence%20·%20Compatibility%20·%20Masters%20·%20Audit-2563eb)

## Download

Get the latest build from **[Releases](../../releases)**:

| System | File |
|---|---|
| Windows x64 | `roado-optimizer-windows.exe` |
| macOS Apple Silicon | `roado-optimizer-macos-arm64` |
| Linux x64 | `roado-optimizer-linux` |

The executable starts a local server on `127.0.0.1:47815` and opens the app in a chromeless window (Edge or Chrome if installed, otherwise your default browser). It stops on its own a few minutes after you close the window. Your data lives in the browser's local storage, and the port is fixed, so it persists between runs.

The binaries are unsigned:
- **Windows**: SmartScreen asks you to confirm. Choose *More info → Run anyway*.
- **macOS**: right-click → *Open*, or run `xattr -d com.apple.quarantine roado-optimizer-macos-arm64`, then `chmod +x` it.
- **Linux**: `chmod +x roado-optimizer-linux && ./roado-optimizer-linux`

**Without the executable:** open `index.html` in a browser, or run `python3 -m http.server 8000` in this folder and open <http://localhost:8000>. Three.js is bundled in `vendor/`. Only the optional Inter web font loads from the internet.

## Features

### Load Optimizer (3D)
- An extreme-point 3D packer with per-SKU **stacking norms**: max layers, max kg on top, max stack height, floor-only, nothing-on-top, rotation and tipping.
- **Multi-drop LIFO**: the last drop is loaded at the nose, and goods for a later drop never block an earlier one.
- **Weight vs volume priority** decides what gets loaded when everything can't fit. Payload is always a hard limit.
- **End-door check**: an item's width × height must pass the door opening.
- **Suggest Vehicle**: finds the smallest vehicle that takes the whole load.
- A step-by-step loading animation, colour by SKU / category / drop, CoG check, and PNG export.

### Open-body height (new)
Open-top trucks, flat racks and ODC trailers are top or crane loaded, so their side walls are not a ceiling. Under **Optimization Settings → Open body**:

| Mode | What may rise above the side walls |
|---|---|
| Off | Nothing. Open trucks are treated like closed ones. |
| Only pieces taller than the walls *(default)* | Only pieces that cannot stand under the walls in any allowed orientation. Everything else, including stacks, stays inside. |
| All items, stacks too | Any piece or stack, up to the height limit. Volume % is then measured up to that limit. |

- **Height limit** = road height limit − deck height. The defaults are 380 cm (the usual CMVR overall-height limit) and 120 cm, which gives 260 cm above the deck. Change them in **Masters → Fleet**, or set **Max load ht** per vehicle.
- **Open top** is a per-vehicle flag in Masters → Fleet. By default it is on for vehicles without an end door that aren't closed containers (e.g. names with OPEN, FR, FT, ODC). An open-top vehicle's end door does not limit what goes in.
- The 3D view draws the height limit as a dashed frame. Pieces above the walls are listed with a *lash & tarp / check route clearance* warning and flagged in the loading-sheet CSV.

### Multi-truck split (new)
When no single vehicle takes the whole load, **Split across trucks** (or Suggest Vehicle, when nothing fits) builds a multi-truck plan:

1. Pieces that fit no vehicle at all are listed separately as needing an ODC / special vehicle.
2. Two ways of dividing the load are tried:
   - **Balanced split**: every item line is shared evenly over *k* trucks of the best vehicle type, so each truck gets the same mix of floor-only, heavy and stackable goods. *k* is the fewest trucks that weight, volume and floor-only deck area allow, and *k* + 1 is also tried. Leftovers go into spare room, then onto extra trucks.
   - **Greedy fill**: while the remainder is too big for one vehicle, a truck is packed as full as the 3D packer can get it. The last part goes into the smallest vehicle that takes it.
3. **Merge pass**: the least-used truck is emptied into the spare room of the others (moving a truck up to a bigger vehicle if that helps). A truck is dropped only when all of its units found a new place.
4. **Downsize pass**: each truck is replaced by the smallest vehicle that still holds its contents.
5. Both strategies run on the best vehicle types within a 20-second budget, and the plan with the fewest trucks wins. Ties go to the lowest market ₹/km when rates are set, otherwise to the smallest total capacity.

The plan shows each truck's 3D layout, utilisation and drops. It also shows a lower bound (from weight, volume and floor-only deck area), so you can see how close the plan is to the theoretical minimum. The item table shows which truck carries what, and the loading-sheet CSV covers all trucks. The split respects the *Deliver to customer* vehicle restriction and the vehicles you tick in Suggest Vehicle.

### Order Planning
- Clubs pending orders into trips per corridor with a max-drops and max-detour limit.
- Customer- and region-level vehicle caps. Bulk orders are split across several vehicles.
- **Long-haul drop sequencing**: the largest load goes last, compared against largest-first using km-weighted utilisation.
- **Owned vs market fleet** by KM slab, with cost per trip once ₹/km rates are entered.
- **Re-plan triggers** (order count AND/OR time interval, plus a max-wait safety net), with a simulator.
- Uses the same open-body height setting as the Load Optimizer.

### Masters, compatibility & audit
SKU master with stacking norms, product categories with a co-loading matrix (ok / no stacking / separate vehicles), customers, region rules, fleet, KM slabs, and a full audit trail. CSV import/export for items and SKUs.

## Item CSV format

```
sku,name,length,width,height,weight,quantity,drop,destination,category,maxStack,maxTopLoadKg,maxStackHeight,stackOnTop,stackUnder,rotationAllowed
PKG-13,New wooden case,40,30,25,220,1,1,Bidar,Ash Handling,2,220,0,true,true,true
```
Lengths are in the unit selected in the header (inches by default), and weight is in kg. If a SKU already exists in the master, blank columns are filled in from it.

## Build the executables

Requires Go 1.22+.

```bash
./build.sh                       # or: GO=/path/to/go ./build.sh
```
This embeds `index.html`, `css/`, `js/` and `vendor/` (pre-gzipped) into `launcher/main.go` and builds all three binaries into `dist/`.

## Project layout

| Path | What it does |
|---|---|
| `js/packer.js` | 3D packer: stacking norms, segregation, LIFO, weight/volume priority, open-body height, multi-truck split |
| `js/planner.js` | Order clubbing, vehicle sizing, drop sequencing, KM-slab fleet choice, re-plan triggers |
| `js/viz.js` | Three.js view |
| `js/app.js` | UI |
| `js/data.js` | Default masters and sample case data |
| `launcher/` | Go launcher that serves the embedded app and opens a browser window |
| `vendor/` | Three.js r128 + OrbitControls |

Lengths are stored internally in cm. Distances are road estimates (straight line × 1.3).

## License

GPL-3.0. See [LICENSE](LICENSE).
