// Store active gRPC streams globally so they persist across HMR reloads in Next.js development mode
const globalRef = global as any;

if (!globalRef.activeStreams) {
  globalRef.activeStreams = new Map<string, any>();
}

export const activeStreams = globalRef.activeStreams;
