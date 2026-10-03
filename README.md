# Pharma Airflow CFD Simulation System

A physics-based web application for simulating and visualizing airflow in pharmaceutical cleanrooms, labs, and production areas.

## 🚀 Features

- **Room Editor**: Create and configure rooms with dimensions and types
- **Vent Placement**: Add supply diffusers and return grills with RPM/flow rate control
- **Obstruction Modeling**: Add equipment, tables, and human presence
- **Real CFD Simulation**: built-in incompressible solver, with OpenFOAM as an optional engine
- **3D Visualization**: Interactive streamlines, velocity vectors, and dead zone detection
- **Deduplication**: Reuse existing simulation results for identical configurations

## 🛠️ Tech Stack

- **Frontend**: Next.js 15 (App Router), React 18, Three.js
- **Backend**: Next.js API Routes
- **Database**: MongoDB
- **CFD Engine**: built-in TypeScript solver (default) or OpenFOAM
- **3D Rendering**: @react-three/fiber, @react-three/drei

## 📋 Prerequisites

- Node.js 18+
- MongoDB (local or Atlas)
- OpenFOAM (Docker or WSL) — **optional**; the built-in solver is used by default

## 🔧 Installation

1. **Clone and install dependencies**:
   ```bash
   cd air-flow
   npm install
   ```

2. **Configure environment**:
   Create `.env.local` file:
   ```env
   # MongoDB Connection
   MONGODB_URI=mongodb://localhost:27017/pharma-airflow

   # CFD engine: builtin | docker | wsl | mock | auto   (default: auto)
   OPENFOAM_ENGINE=builtin
   OPENFOAM_DOCKER_IMAGE=openfoam/openfoam10-paraview510
   OPENFOAM_BASHRC=/opt/openfoam10/etc/bashrc
   SIMULATION_OUTPUT_DIR=./simulations

   # Built-in solver tuning (optional)
   SOLVER_MAX_CELLS=30000   # cell budget; ~11k cells solves in ~20s
   SOLVER_MAX_STEPS=240     # cap on steady-state iterations
   SOLVER_CELL_SIZE=0.2     # preferred cell size in metres
   ```

3. **Start MongoDB** (if local):
   ```bash
   mongod
   ```

4. **Run development server**:
   ```bash
   npm run dev
   ```

5. **Open**: http://localhost:3000

## 📁 Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── room/           # Room CRUD APIs
│   │   ├── simulation/     # Simulation trigger & status
│   │   └── results/        # Visualization data
│   ├── editor/             # Room editor page
│   ├── viewer/[id]/        # Airflow visualization
│   └── page.tsx            # Dashboard
├── backend/
│   ├── openfoam/
│   │   ├── runner/         # Engine selection + OpenFOAM case execution
│   │   └── postprocess/    # OpenFOAM result parsing
│   └── solver/             # Built-in CFD solver
│       ├── grid.ts         # Cartesian grid, vent patches, obstruction masking
│       ├── airflowSolver.ts# Advection / diffusion / pressure projection
│       └── postprocess.ts  # Streamlines, dead zones, statistics
├── components/
│   ├── editor/             # 3D room preview
│   └── viewer/             # Airflow visualization
├── db/
│   ├── models/             # MongoDB schemas
│   └── connection.ts       # DB connection
├── lib/
│   ├── physics/            # Airflow calculations
│   └── hash/               # Config deduplication
└── types/                  # TypeScript interfaces
```

## 🧪 CFD Engines

Selected with `OPENFOAM_ENGINE`. With `auto` (or unset) the app uses Docker or
WSL only when they are actually installed, and otherwise runs the built-in
solver — so a simulation never fails just because OpenFOAM is missing. If an
OpenFOAM run errors part-way, the built-in solver finishes the job.

### Option 1: `builtin` — in-process solver (default, no installation)
A steady-state incompressible solver over a Cartesian grid of the room
(`src/backend/solver`):

- semi-Lagrangian advection, so the time step is not CFL-limited
- pressure projection (red-black SOR) to enforce mass conservation
- Chen & Xu (1998) zero-equation turbulence closure, `ν_t = 0.03874 · |V| · l`,
  the standard algebraic model for indoor airflow
- no-slip walls; obstructions are blocked cells; diffusers and return grills are
  fixed-velocity patches, balanced so supply flow equals extract flow

Supply flow is preserved exactly when vent footprints snap to the grid, so the
achieved ACH matches the configuration. Each run writes a `report.json` next to
its results with the grid size, achieved ACH and convergence history.

### Option 2: `docker` — OpenFOAM in a container
```bash
docker pull openfoam/openfoam10-paraview510
```

### Option 3: `wsl` — WSL2 + native OpenFOAM
```bash
# In Ubuntu (WSL)
sudo sh -c "wget -O - https://dl.openfoam.org/gpg.key | apt-key add -"
sudo add-apt-repository http://dl.openfoam.org/ubuntu
sudo apt update
sudo apt install openfoam10
```
Note: the OpenFOAM field parser in `postprocess/resultProcessor.ts` is still a
stub, so these engines mesh and solve but hand post-processing back to the
built-in solver until it is implemented.

### Option 4: `mock` — synthetic results
Set `OPENFOAM_ENGINE=mock` (or the legacy `OPENFOAM_SIMULATE=true`) for UI work.

## 🏭 Facility view (`/facility`)

The ground-floor process block (Indiana Ophthalmic) as a 3D building, with the
HVAC data from `RDS GF_INDIANA.xlsx`:

- **Layout** – `src/lib/facility/presets/indianaGroundFloor.ts`: room footprints
  and doors traced from the GF AHU-zoning / area-classification drawings; every
  flow, pressure, class and terminal count comes from the RDS, including the
  AHU summary rows (AHU CFM, fresh air, bleed). Walls are derived from the
  footprints and terminals are auto-placed from the RDS counts
  (`src/lib/facility/geometry.ts`).
- **Live pressures** – `src/lib/facility/network.ts` is a room pressure network
  (CONTAM-style): supply dampers + HEPA filters, return risers + dampers, door
  leakage (2 mm gap shut, full orifice open), AHU fan curves scaled by VFD
  frequency, fresh-air and bleed dampers, exhaust fans. It is commissioned so
  the design state (doors shut, 45 Hz) reproduces the RDS pressures, then
  re-solves in milliseconds for any change — open a door, move a damper, drop
  a VFD, load the filters — and every room's pressure updates.
- **CFD** – `src/backend/solver/facilityGrid.ts` + `facilityRun.ts` run the
  built-in solver over the whole floor for the current door / flow state
  (~25 s at 25 cm cells) and return streamlines, a 1.2 m vector slice, dead
  zones, per-room ACPH / stagnant volume and door flows. Jobs are cached under
  `simulations/facility/<hash>/` (no MongoDB needed).
- **Layout** – room geometry is checked against `13 GF AHU ZONING`; the rest of
  the floor on that drawing (PPM store, lobby, stairs, lift, toilets) is shown
  as unventilated context. Hall AHUs follow the drawing (Hall-1 → AHU-5A,
  Hall-2 → AHU-5B), which is the reverse of the RDS; the RDS check tab notes it.
- **Edit layout** – rooms start empty. "Move blowers & suckers" in a room's
  panel lists its supply terminals (HEPAs / diffusers) and its return risers /
  exhaust grilles; drag them (or the coloured ring under each) or type X / Y.
  Equipment, benches and people can be added too. Room studies use exactly
  the terminals shown, including moves.
- **Room CFD** – one room on a 10 cm grid, with the air crossing its doors
  taken from the pressure network. Every solve ends with an exact face-based
  projection, so the flow conserves mass cell by cell (before this, up to a
  quarter of a room's supply could "disappear" between ceiling and floor).
  4-way ceiling diffusers throw sideways 30° below the ceiling; HEPAs discharge
  straight down.
- **HVAC check** – one table with supply damper % open, riser damper % open and
  riser face velocity, fresh air and bleed air, AHU VFD Hz / speed / rpm / kW /
  current, supply and return static, and HEPA plenum static and terminal
  (filter) ΔP, each marked pass / warn / fail against stated limits; exports CSV.
- **Smoke test** – a gowned operator raises a fogger wand into the HEPA air and
  sweeps it at working height; the smoke is advected through the room CFD field
  (face-interpolated, so it never leaks through walls) with turbulent mixing,
  tracer balls fall from the supply faces, and both are drawn into the actual
  risers / door gaps (no ball is ever recycled mid-room: everything that enters
  leaves through the suction). The test is complete when 95 % of the smoke has
  left; the panel reports that time, where the smoke left, and the 100:1
  recovery time extrapolated from it (ISO 14644-3). While walking through a
  room, its supply air is shown as the same moving balls (`src/lib/facility/smoke.ts`, `src/components/facility/SmokeTest3D.tsx`).
- **Walk-through** – "🚶 Walk-through" (or "Walk inside this room" on a room)
  puts you in the room at eye height: mouse to look, WASD / arrows to move,
  Shift to walk faster, F to open or close the nearest door (it really opens
  in the pressure model), 1 / 2 / 3 toggle streamlines / smoke / arrows. The
  smoke moves at the CFD air speed; the HUD shows the room's live pressure and
  door flows, the air speed and direction where you stand, and a minimap
  (`src/lib/facility/tour.ts`, `src/components/facility/TourHud.tsx`).

## 📖 User Guide

1. **Create a Room**: Set dimensions and type (cleanroom, lab, etc.)
2. **Add Vents**: Place supply diffusers (ceiling) and return grills (walls)
3. **Add Obstructions**: Equipment, tables, or human presence
4. **Run Simulation**: System checks for duplicate configs or runs new CFD
5. **View Results**: Interactive 3D visualization with streamlines and dead zones

## 🔬 Physics Model

- **Solver**: built-in steady-state projection solver, or simpleFoam (steady-state RANS)
- **Turbulence**: zero-equation eddy viscosity (built-in) or k-epsilon (OpenFOAM)
- **RPM to Velocity**: V = (π × D × RPM × η) / 60
- **Dead Zone Detection**: Regions with velocity < 0.05 m/s

## 📝 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/room` | GET/POST | List/create rooms |
| `/api/room/[id]` | GET/PUT/DELETE | Single room operations |
| `/api/simulation` | POST | Trigger simulation |
| `/api/simulation/[id]` | GET | Get simulation details |
| `/api/simulation/status/[id]` | GET | Poll simulation progress |
| `/api/results/[id]` | GET | Get visualization data |

## 🔮 Future Enhancements

- GPU-accelerated mesh generation
- Thermal simulation (human heat emission)
- Particle tracking
- Compliance report generation
- Multi-user support

## 📄 License

MIT
