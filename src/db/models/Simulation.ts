import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { 
  SimulationStatus, 
  IDeadZone,
  ISimulationStatistics,
  ISimulationResults
} from '@/types';

// Document interface for mongoose
export interface ISimulationDocument extends Document {
  configurationId: Types.ObjectId;
  configHash: string;
  roomId: Types.ObjectId;
  status: SimulationStatus;
  progress: number;
  statusMessage?: string;
  casePath?: string;
  resultsPath?: string;
  results?: ISimulationResults;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const Vector3DSchema = new Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  { _id: false }
);

const DeadZoneSchema = new Schema(
  {
    position: { type: Vector3DSchema, required: true },
    volume: { type: Number, required: true },
    velocityMagnitude: { type: Number, required: true },
  },
  { _id: false }
);

const StatisticsSchema = new Schema(
  {
    maxVelocity: { type: Number, required: true },
    avgVelocity: { type: Number, required: true },
    minVelocity: { type: Number, required: true },
    minPressure: { type: Number, required: true },
    maxPressure: { type: Number, required: true },
    avgPressure: { type: Number, required: true },
  },
  { _id: false }
);

const ResultsSchema = new Schema(
  {
    velocityField: { type: String },
    pressureField: { type: String },
    streamlines: { type: String },
    deadZones: { type: [DeadZoneSchema], default: [] },
    statistics: { type: StatisticsSchema },
  },
  { _id: false }
);

const SimulationSchema = new Schema<ISimulationDocument>(
  {
    configurationId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Configuration', 
      required: true,
      index: true 
    },
    configHash: { 
      type: String, 
      required: true, 
      index: true 
    },
    roomId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Room', 
      required: true,
      index: true 
    },
    status: { 
      type: String, 
      required: true, 
      enum: ['pending', 'meshing', 'running', 'postprocessing', 'completed', 'failed'],
      default: 'pending'
    },
    progress: { 
      type: Number, 
      default: 0, 
      min: 0, 
      max: 100 
    },
    statusMessage: { type: String },
    casePath: { type: String },
    resultsPath: { type: String },
    results: { type: ResultsSchema },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Indexes
SimulationSchema.index({ roomId: 1, status: 1 });
SimulationSchema.index({ configHash: 1 }, { unique: false });
SimulationSchema.index({ status: 1, createdAt: -1 });

const Simulation: Model<ISimulationDocument> = 
  mongoose.models.Simulation || mongoose.model<ISimulationDocument>('Simulation', SimulationSchema);

export default Simulation;
