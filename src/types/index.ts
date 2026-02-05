// TypeScript interfaces for Pharma Airflow Simulation System

// ============= Common Types =============
export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface Dimensions3D {
  width: number;
  height: number;
  depth: number;
}

// ============= Room Types =============
export type RoomType = 'cleanroom' | 'lab' | 'corridor' | 'production';

export interface IRoomDimensions {
  length: number;  // meters
  width: number;   // meters
  height: number;  // meters
}

export interface IRoom {
  _id?: string;
  name: string;
  type: RoomType;
  dimensions: IRoomDimensions;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============= Supply Diffuser Types =============
export type FlowType = 'flowRate' | 'rpm';

export interface ISupplyDiffuser {
  id: string;
  name?: string;
  position: Vector3D;
  size: Size2D;
  flowType: FlowType;
  flowRate?: number;      // m³/s (if flowType is 'flowRate')
  fanRPM?: number;        // RPM (if flowType is 'rpm')
  fanDiameter?: number;   // meters (for RPM to velocity conversion)
  calculatedVelocity?: number;  // m/s (computed)
}

// ============= Return Grill Types =============
export interface IReturnGrill {
  id: string;
  name?: string;
  position: Vector3D;
  size: Size2D;
}

// ============= Obstruction Types =============
export type ObstructionType = 'equipment' | 'table' | 'partition' | 'human';
export type ObstructionShape = 'cuboid' | 'cylinder';
export type HumanPosture = 'standing' | 'working' | 'sitting';

export interface IObstruction {
  id: string;
  name?: string;
  type: ObstructionType;
  shape: ObstructionShape;
  position: Vector3D;
  // For cuboid
  dimensions?: Dimensions3D;
  // For cylinder
  radius?: number;
  height?: number;
  // Human-specific
  humanPosture?: HumanPosture;
  emitsHeat?: boolean;  // Future: for thermal simulation
}

// ============= Airflow Parameters =============
export interface IAirflowParams {
  targetACH: number;        // Air Changes per Hour
  temperature?: number;      // Kelvin (default: 293.15 = 20°C)
  pressure?: number;         // Pa (default: 101325 = 1 atm)
  humidity?: number;         // Relative humidity % (future use)
}

// ============= Configuration Types =============
export interface IConfiguration {
  _id?: string;
  roomId: string;
  configHash: string;  // SHA-256 hash for deduplication
  
  supplyDiffusers: ISupplyDiffuser[];
  returnGrills: IReturnGrill[];
  obstructions: IObstruction[];
  airflowParams: IAirflowParams;
  
  createdAt?: Date;
}

// ============= Simulation Types =============
export type SimulationStatus = 
  | 'pending' 
  | 'meshing' 
  | 'running' 
  | 'postprocessing' 
  | 'completed' 
  | 'failed';

export interface IDeadZone {
  position: Vector3D;
  volume: number;  // m³
  velocityMagnitude: number;  // m/s (low velocity indicates dead zone)
}

export interface ISimulationStatistics {
  maxVelocity: number;      // m/s
  avgVelocity: number;      // m/s
  minVelocity: number;      // m/s
  minPressure: number;      // Pa
  maxPressure: number;      // Pa
  avgPressure: number;      // Pa
}

export interface ISimulationResults {
  velocityField: string;    // JSON file path
  pressureField: string;    // JSON file path
  streamlines: string;      // JSON file path
  deadZones: IDeadZone[];
  statistics: ISimulationStatistics;
}

export interface ISimulation {
  _id?: string;
  configurationId: string;
  configHash: string;
  roomId: string;
  
  status: SimulationStatus;
  progress: number;  // 0-100
  statusMessage?: string;
  
  casePath?: string;           // Path to OpenFOAM case directory
  resultsPath?: string;        // Path to processed results
  
  results?: ISimulationResults;
  
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
}

// ============= API Request/Response Types =============
export interface CreateRoomRequest {
  name: string;
  type: RoomType;
  dimensions: IRoomDimensions;
}

export interface CreateSimulationRequest {
  roomId: string;
  supplyDiffusers: ISupplyDiffuser[];
  returnGrills: IReturnGrill[];
  obstructions: IObstruction[];
  airflowParams: IAirflowParams;
}

export interface SimulationTriggerResponse {
  simulationId: string;
  reused: boolean;
  status: SimulationStatus;
  message: string;
}

export interface SimulationStatusResponse {
  status: SimulationStatus;
  progress: number;
  message: string;
  results?: ISimulationResults;
}

// ============= Visualization Data Types =============
export interface IStreamline {
  id: string;
  points: Vector3D[];
  velocities: number[];  // Velocity magnitude at each point
}

export interface IVelocityVector {
  position: Vector3D;
  direction: Vector3D;
  magnitude: number;
}

export interface IVisualizationData {
  streamlines: IStreamline[];
  velocityVectors: IVelocityVector[];
  deadZones: IDeadZone[];
  statistics: ISimulationStatistics;
  colorRange: {
    min: number;
    max: number;
  };
}

// ============= Mesh Types (OpenFOAM) =============
export interface IMeshSettings {
  baseResolution: number;  // Base cell size in meters
  refinementLevel: number; // Refinement near walls/objects (1-5)
  boundaryLayers: number;  // Number of boundary layer cells
}
