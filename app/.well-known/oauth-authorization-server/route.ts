import { authServerGET, metadataOPTIONS } from "@/mcp/metadata-routes";

// Clerk's authorization-server metadata, mirrored for older MCP clients. See src/mcp/metadata-routes.ts.
export { authServerGET as GET, metadataOPTIONS as OPTIONS };
