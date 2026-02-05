import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { 
  ISupplyDiffuser, 
  IReturnGrill, 
  IObstruction,
  IAirflowParams
} from '@/types';

// Document interface for mongoose
export interface IConfigurationDocument extends Document {
  roomId: Types.ObjectId;
  configHash: string;
  supplyDiffusers: ISupplyDiffuser[];
  returnGrills: IReturnGrill[];
  obstructions: IObstruction[];
  airflowParams: IAirflowParams;
  createdAt?: Date;
  updatedAt?: Date;
}

// Sub-schemas
const Vector3DSchema = new Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  { _id: false }
);

const Size2DSchema = new Schema(
  {
    width: { type: Number, required: true, min: 0.01 },
    height: { type: Number, required: true, min: 0.01 },
  },
  { _id: false }
);

const Dimensions3DSchema = new Schema(
  {
    width: { type: Number, min: 0.01 },
    height: { type: Number, min: 0.01 },
    depth: { type: Number, min: 0.01 },
  },
  { _id: false }
);

const SupplyDiffuserSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String },
    position: { type: Vector3DSchema, required: true },
    size: { type: Size2DSchema, required: true },
    flowType: { 
      type: String, 
      required: true, 
      enum: ['flowRate', 'rpm']
    },
    flowRate: { type: Number, min: 0 },
    fanRPM: { type: Number, min: 0 },
    fanDiameter: { type: Number, min: 0.01, default: 0.3 },
    calculatedVelocity: { type: Number },
  },
  { _id: false }
);

const ReturnGrillSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String },
    position: { type: Vector3DSchema, required: true },
    size: { type: Size2DSchema, required: true },
  },
  { _id: false }
);

const ObstructionSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String },
    type: { 
      type: String, 
      required: true, 
      enum: ['equipment', 'table', 'partition', 'human']
    },
    shape: { 
      type: String, 
      required: true, 
      enum: ['cuboid', 'cylinder']
    },
    position: { type: Vector3DSchema, required: true },
    dimensions: { type: Dimensions3DSchema },
    radius: { type: Number, min: 0.01 },
    height: { type: Number, min: 0.01 },
    humanPosture: { 
      type: String, 
      enum: ['standing', 'working', 'sitting']
    },
    emitsHeat: { type: Boolean, default: false },
  },
  { _id: false }
);

const AirflowParamsSchema = new Schema(
  {
    targetACH: { type: Number, required: true, min: 1 },
    temperature: { type: Number, default: 293.15 },
    pressure: { type: Number, default: 101325 },
    humidity: { type: Number, min: 0, max: 100 },
  },
  { _id: false }
);

const ConfigurationSchema = new Schema<IConfigurationDocument>(
  {
    roomId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Room', 
      required: true,
      index: true 
    },
    configHash: { 
      type: String, 
      required: true, 
      index: true,
      unique: true 
    },
    supplyDiffusers: { 
      type: [SupplyDiffuserSchema], 
      required: true
    },
    returnGrills: { 
      type: [ReturnGrillSchema], 
      required: true
    },
    obstructions: { 
      type: [ObstructionSchema], 
      default: [] 
    },
    airflowParams: { 
      type: AirflowParamsSchema, 
      required: true 
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

ConfigurationSchema.index({ roomId: 1, configHash: 1 });

const Configuration: Model<IConfigurationDocument> = 
  mongoose.models.Configuration || mongoose.model<IConfigurationDocument>('Configuration', ConfigurationSchema);

export default Configuration;
