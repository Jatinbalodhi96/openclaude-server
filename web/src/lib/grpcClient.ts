import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

const PROTO_PATH = path.join(process.cwd(), '../protos/openclaude.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
export const OpenClaudeServiceClient = (protoDescriptor.openclaude as any).OpenClaudeService;

export const getClient = () => {
  return new OpenClaudeServiceClient(
    'localhost:50051',
    grpc.credentials.createInsecure()
  );
};
