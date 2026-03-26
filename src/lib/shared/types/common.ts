export type KnownOsmElementType = 'way' | 'relation';
export type OsmElementType = KnownOsmElementType | (string & {});

export type UnknownRecord = Record<string, unknown>;
export type StringRecord = Record<string, string>;
