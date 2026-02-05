import mongoose, { Schema, Document, Model } from 'mongoose';
import { IRoom, RoomType, IRoomDimensions } from '@/types';

export interface IRoomDocument extends Omit<IRoom, '_id'>, Document {}

const RoomDimensionsSchema = new Schema<IRoomDimensions>(
  {
    length: { type: Number, required: true, min: 0.1 },
    width: { type: Number, required: true, min: 0.1 },
    height: { type: Number, required: true, min: 0.1 },
  },
  { _id: false }
);

const RoomSchema = new Schema<IRoomDocument>(
  {
    name: { 
      type: String, 
      required: true, 
      trim: true,
      maxlength: 100 
    },
    type: { 
      type: String, 
      required: true, 
      enum: ['cleanroom', 'lab', 'corridor', 'production'] as RoomType[]
    },
    dimensions: { 
      type: RoomDimensionsSchema, 
      required: true 
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual for room volume
RoomSchema.virtual('volume').get(function (this: IRoomDocument) {
  return this.dimensions.length * this.dimensions.width * this.dimensions.height;
});

// Index for faster queries
RoomSchema.index({ name: 1 });
RoomSchema.index({ type: 1 });

// Prevent model recompilation in development
const Room: Model<IRoomDocument> = 
  mongoose.models.Room || mongoose.model<IRoomDocument>('Room', RoomSchema);

export default Room;
