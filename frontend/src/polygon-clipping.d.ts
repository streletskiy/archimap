declare module 'polygon-clipping' {
  const polygonClipping: {
    union: (...geometries: unknown[]) => unknown;
    difference: (subject: unknown, clip: unknown) => unknown;
  };

  export default polygonClipping;
}
