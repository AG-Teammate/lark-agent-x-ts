// Protocol assets imported `with { type: 'file' }`: the value is a runtime-readable path (a $bunfs path inside a single-file executable).
declare module '*.binpb' {
  const path: string;
  export default path;
}
