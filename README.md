# Pharma Airflow CFD Simulation System

A physics-based web application for simulating and visualizing airflow in pharmaceutical cleanrooms, labs, and production areas.

## 🚀 Features

- **Room Editor**: Create and configure rooms with dimensions and types
- **Vent Placement**: Add supply diffusers and return grills with RPM/flow rate control
- **Obstruction Modeling**: Add equipment, tables, and human presence
- **Real CFD Simulation**: OpenFOAM-powered airflow computation
- **3D Visualization**: Interactive streamlines, velocity vectors, and dead zone detection
- **Deduplication**: Reuse existing simulation results for identical configurations

## 🛠️ Tech Stack

- **Frontend**: Next.js 15 (App Router), React 18, Three.js
- **Backend**: Next.js API Routes
- **Database**: MongoDB
- **CFD Engine**: OpenFOAM
- **3D Rendering**: @react-three/fiber, @react-three/drei

## 📋 Prerequisites

- Node.js 18+
- MongoDB (local or Atlas)
- OpenFOAM (Docker or WSL) - *optional for mock mode*

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
   
   # OpenFOAM Configuration
   OPENFOAM_USE_DOCKER=false
   OPENFOAM_SIMULATE=true  # Set to true for development (mock results)
   OPENFOAM_DOCKER_IMAGE=openfoam/openfoam10-paraview510
   SIMULATION_OUTPUT_DIR=./simulations
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
│   └── openfoam/
│       ├── runner/         # Simulation execution
│       └── postprocess/    # Result processing
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

## 🧪 OpenFOAM Setup

### Option 1: Mock Mode (Development)
Set `OPENFOAM_SIMULATE=true` to generate mock results without OpenFOAM.

### Option 2: Docker (Recommended for Windows)
```bash
docker pull openfoam/openfoam10-paraview510
```
Set `OPENFOAM_USE_DOCKER=true`

### Option 3: WSL2 + Native OpenFOAM
```bash
# In Ubuntu (WSL)
sudo sh -c "wget -O - https://dl.openfoam.org/gpg.key | apt-key add -"
sudo add-apt-repository http://dl.openfoam.org/ubuntu
sudo apt update
sudo apt install openfoam10
```

## 📖 User Guide

1. **Create a Room**: Set dimensions and type (cleanroom, lab, etc.)
2. **Add Vents**: Place supply diffusers (ceiling) and return grills (walls)
3. **Add Obstructions**: Equipment, tables, or human presence
4. **Run Simulation**: System checks for duplicate configs or runs new CFD
5. **View Results**: Interactive 3D visualization with streamlines and dead zones

## 🔬 Physics Model

- **Solver**: simpleFoam (steady-state RANS)
- **Turbulence**: k-epsilon model
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
