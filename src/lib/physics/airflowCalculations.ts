/**
 * Physics calculations for airflow simulation
 * These functions convert between different airflow parameters
 */

import { ISupplyDiffuser, IAirflowParams, IRoomDimensions } from '@/types';

/**
 * Convert fan RPM to outlet velocity
 * 
 * For centrifugal fans, the relationship between RPM and air velocity is:
 * V = (π × D × RPM × η) / 60
 * 
 * Where:
 * - D = impeller/fan diameter (meters)
 * - RPM = rotations per minute
 * - η = fan efficiency (typically 0.6-0.8)
 * 
 * @param rpm - Fan RPM
 * @param fanDiameter - Impeller diameter in meters (default: 0.3m)
 * @param efficiency - Fan efficiency factor (default: 0.7)
 * @returns Velocity in m/s
 */
export function rpmToVelocity(
  rpm: number, 
  fanDiameter: number = 0.3, 
  efficiency: number = 0.7
): number {
  if (rpm <= 0) return 0;
  return (Math.PI * fanDiameter * rpm * efficiency) / 60;
}

/**
 * Convert flow rate to velocity based on vent area
 * 
 * Q = A × V  →  V = Q / A
 * 
 * @param flowRate - Flow rate in m³/s
 * @param ventWidth - Vent width in meters
 * @param ventHeight - Vent height in meters
 * @returns Velocity in m/s
 */
export function flowRateToVelocity(
  flowRate: number, 
  ventWidth: number, 
  ventHeight: number
): number {
  const area = ventWidth * ventHeight;
  if (area <= 0) return 0;
  return flowRate / area;
}

/**
 * Calculate the velocity for a supply diffuser based on its configuration
 * 
 * @param diffuser - Supply diffuser configuration
 * @returns Calculated velocity in m/s
 */
export function calculateDiffuserVelocity(diffuser: ISupplyDiffuser): number {
  if (diffuser.flowType === 'rpm' && diffuser.fanRPM) {
    return rpmToVelocity(diffuser.fanRPM, diffuser.fanDiameter || 0.3);
  } else if (diffuser.flowType === 'flowRate' && diffuser.flowRate) {
    return flowRateToVelocity(
      diffuser.flowRate, 
      diffuser.size.width, 
      diffuser.size.height
    );
  }
  return 0;
}

/**
 * Calculate required total flow rate to achieve target ACH
 * 
 * ACH = (Q × 3600) / V_room  →  Q = (ACH × V_room) / 3600
 * 
 * @param targetACH - Target Air Changes per Hour
 * @param roomDimensions - Room dimensions in meters
 * @returns Required total flow rate in m³/s
 */
export function calculateRequiredFlowRate(
  targetACH: number, 
  roomDimensions: IRoomDimensions
): number {
  const roomVolume = roomDimensions.length * roomDimensions.width * roomDimensions.height;
  return (targetACH * roomVolume) / 3600;
}

/**
 * Calculate actual ACH based on supply diffusers
 * 
 * @param diffusers - Array of supply diffusers
 * @param roomDimensions - Room dimensions
 * @returns Calculated ACH
 */
export function calculateActualACH(
  diffusers: ISupplyDiffuser[], 
  roomDimensions: IRoomDimensions
): number {
  const roomVolume = roomDimensions.length * roomDimensions.width * roomDimensions.height;
  
  // Calculate total flow rate from all diffusers
  let totalFlowRate = 0;
  for (const diffuser of diffusers) {
    const velocity = calculateDiffuserVelocity(diffuser);
    const area = diffuser.size.width * diffuser.size.height;
    totalFlowRate += velocity * area;
  }
  
  // ACH = Q × 3600 / V
  return (totalFlowRate * 3600) / roomVolume;
}

/**
 * Calculate air density based on temperature and pressure
 * Using ideal gas law: ρ = P / (R × T)
 * 
 * @param temperature - Temperature in Kelvin (default: 293.15K = 20°C)
 * @param pressure - Pressure in Pa (default: 101325 Pa = 1 atm)
 * @returns Air density in kg/m³
 */
export function calculateAirDensity(
  temperature: number = 293.15, 
  pressure: number = 101325
): number {
  const R_air = 287.058; // Specific gas constant for dry air (J/(kg·K))
  return pressure / (R_air * temperature);
}

/**
 * Calculate kinematic viscosity of air
 * Using Sutherland's formula approximation
 * 
 * @param temperature - Temperature in Kelvin
 * @returns Kinematic viscosity in m²/s
 */
export function calculateKinematicViscosity(temperature: number = 293.15): number {
  // Sutherland's constants for air
  const T0 = 273.15; // Reference temperature (K)
  const mu0 = 1.716e-5; // Reference dynamic viscosity (Pa·s)
  const S = 110.4; // Sutherland's constant (K)
  
  // Dynamic viscosity using Sutherland's formula
  const mu = mu0 * Math.pow(temperature / T0, 1.5) * (T0 + S) / (temperature + S);
  
  // Kinematic viscosity = dynamic viscosity / density
  const rho = calculateAirDensity(temperature);
  return mu / rho;
}

/**
 * Calculate Reynolds number for a duct/vent
 * Re = (V × D_h) / ν
 * 
 * @param velocity - Flow velocity in m/s
 * @param hydraulicDiameter - Hydraulic diameter in meters
 * @param temperature - Air temperature in Kelvin
 * @returns Reynolds number
 */
export function calculateReynoldsNumber(
  velocity: number, 
  hydraulicDiameter: number, 
  temperature: number = 293.15
): number {
  const nu = calculateKinematicViscosity(temperature);
  return (velocity * hydraulicDiameter) / nu;
}

/**
 * Calculate hydraulic diameter for rectangular duct
 * D_h = 4A / P = 4(W×H) / 2(W+H) = 2WH / (W+H)
 * 
 * @param width - Duct width in meters
 * @param height - Duct height in meters
 * @returns Hydraulic diameter in meters
 */
export function calculateHydraulicDiameter(width: number, height: number): number {
  return (2 * width * height) / (width + height);
}

/**
 * Estimate turbulent kinetic energy (k) at inlet
 * k = 1.5 × (I × U)²
 * 
 * @param velocity - Mean velocity in m/s
 * @param turbulenceIntensity - Turbulence intensity (default: 0.05 = 5%)
 * @returns Turbulent kinetic energy in m²/s²
 */
export function estimateTurbulentKineticEnergy(
  velocity: number, 
  turbulenceIntensity: number = 0.05
): number {
  return 1.5 * Math.pow(turbulenceIntensity * velocity, 2);
}

/**
 * Estimate turbulent dissipation rate (epsilon) at inlet
 * ε = C_μ^(3/4) × k^(3/2) / l
 * 
 * @param turbulentKineticEnergy - k value in m²/s²
 * @param mixingLength - Turbulent mixing length in meters
 * @returns Turbulent dissipation rate in m²/s³
 */
export function estimateTurbulentDissipation(
  turbulentKineticEnergy: number, 
  mixingLength: number
): number {
  const C_mu = 0.09;
  return Math.pow(C_mu, 0.75) * Math.pow(turbulentKineticEnergy, 1.5) / mixingLength;
}

/**
 * Estimate specific dissipation rate (omega) for k-omega model
 * ω = k^(1/2) / (C_μ^(1/4) × l)
 * 
 * @param turbulentKineticEnergy - k value in m²/s²
 * @param mixingLength - Turbulent mixing length in meters
 * @returns Specific dissipation rate in 1/s
 */
export function estimateSpecificDissipation(
  turbulentKineticEnergy: number, 
  mixingLength: number
): number {
  const C_mu = 0.09;
  return Math.sqrt(turbulentKineticEnergy) / (Math.pow(C_mu, 0.25) * mixingLength);
}
