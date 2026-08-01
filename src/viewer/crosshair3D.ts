import vtkLineSource from '@kitware/vtk.js/Filters/Sources/LineSource';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';

// Point3 is not re-exported from the top-level @cornerstonejs/core entry; it
// lives under Types.Point3. Define a local alias to keep this module decoupled
// from Cornerstone's internal type layout.
type Point3 = [number, number, number];

/**
 * A true 3D crosshair marker rendered inside the VolumeViewport3D as vtk actors:
 * three axis-aligned lines (x/y/z) through the MPR slice intersection point, plus
 * a small sphere at the intersection. Because these are real 3D actors, they are
 * occluded by opaque tissue in front and visible through transparent regions /
 * outside the volume — giving correct depth perception (unlike a 2D SVG overlay).
 *
 * Lines span the volume bounds + a margin so they poke OUT beyond the surface and
 * remain visible even when the intersection point is deep inside the volume.
 */

const LINE_COLOR: [number, number, number] = [0.13, 0.83, 0.93]; // cyan ~#22d3ee
const MARGIN_RATIO = 0.12; // extend lines 12% beyond bounds on each side

export const CROSSHAIR_ACTOR_UIDS = ['xhair-x', 'xhair-y', 'xhair-z', 'xhair-sphere'] as const;

export interface Crosshair3D {
  lineSources: [vtkLineSource, vtkLineSource, vtkLineSource];
  sphereSource: vtkSphereSource;
  actors: { uid: string; actor: vtkActor }[];
}

function makeLineActor(src: vtkLineSource): vtkActor {
  const mapper = vtkMapper.newInstance();
  mapper.setInputConnection(src.getOutputPort());
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setColor(LINE_COLOR[0], LINE_COLOR[1], LINE_COLOR[2]);
  prop.setLineWidth(3);
  return actor;
}

function makeSphereActor(src: vtkSphereSource): vtkActor {
  const mapper = vtkMapper.newInstance();
  mapper.setInputConnection(src.getOutputPort());
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setColor(LINE_COLOR[0], LINE_COLOR[1], LINE_COLOR[2]);
  return actor;
}

/** Compute line endpoints along an axis through `world`, extending beyond bounds. */
function axisEndpoints(world: Point3, bounds: number[]): {
  x: [Point3, Point3];
  y: [Point3, Point3];
  z: [Point3, Point3];
  radius: number;
} {
  const [xmin, xmax, ymin, ymax, zmin, zmax] = bounds;
  const mx = (xmax - xmin) * MARGIN_RATIO;
  const my = (ymax - ymin) * MARGIN_RATIO;
  const mz = (zmax - zmin) * MARGIN_RATIO;
  return {
    x: [[xmin - mx, world[1], world[2]], [xmax + mx, world[1], world[2]]],
    y: [[world[0], ymin - my, world[2]], [world[0], ymax + my, world[2]]],
    z: [[world[0], world[1], zmin - mz], [world[0], world[1], zmax + mz]],
    radius: Math.hypot(xmax - xmin, ymax - ymin, zmax - zmin) * 0.012,
  };
}

export function createCrosshair3D(world: Point3, bounds: number[]): Crosshair3D {
  const e = axisEndpoints(world, bounds);
  const lineX = vtkLineSource.newInstance({ point1: e.x[0], point2: e.x[1], resolution: 2 });
  const lineY = vtkLineSource.newInstance({ point1: e.y[0], point2: e.y[1], resolution: 2 });
  const lineZ = vtkLineSource.newInstance({ point1: e.z[0], point2: e.z[1], resolution: 2 });
  const sphere = vtkSphereSource.newInstance({
    center: world,
    radius: e.radius,
    thetaResolution: 16,
    phiResolution: 16,
  });

  const actors = [
    { uid: CROSSHAIR_ACTOR_UIDS[0], actor: makeLineActor(lineX) },
    { uid: CROSSHAIR_ACTOR_UIDS[1], actor: makeLineActor(lineY) },
    { uid: CROSSHAIR_ACTOR_UIDS[2], actor: makeLineActor(lineZ) },
    { uid: CROSSHAIR_ACTOR_UIDS[3], actor: makeSphereActor(sphere) },
  ];

  return { lineSources: [lineX, lineY, lineZ], sphereSource: sphere, actors };
}

/** Update the crosshair position in-place (no actor re-creation). */
export function setCrosshair3DPosition(ch: Crosshair3D, world: Point3, bounds: number[]) {
  const e = axisEndpoints(world, bounds);
  ch.lineSources[0].setPoint1(e.x[0][0], e.x[0][1], e.x[0][2]);
  ch.lineSources[0].setPoint2(e.x[1][0], e.x[1][1], e.x[1][2]);
  ch.lineSources[1].setPoint1(e.y[0][0], e.y[0][1], e.y[0][2]);
  ch.lineSources[1].setPoint2(e.y[1][0], e.y[1][1], e.y[1][2]);
  ch.lineSources[2].setPoint1(e.z[0][0], e.z[0][1], e.z[0][2]);
  ch.lineSources[2].setPoint2(e.z[1][0], e.z[1][1], e.z[1][2]);
  ch.sphereSource.setCenter(world[0], world[1], world[2]);
  ch.sphereSource.setRadius(e.radius);
}
