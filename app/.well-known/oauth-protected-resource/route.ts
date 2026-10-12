import { metadataOPTIONS, protectedResourceGET } from "@/mcp/metadata-routes";

// RFC 9728 protected-resource metadata for the MCP endpoint. See src/mcp/oauth-metadata.ts.
export { protectedResourceGET as GET, metadataOPTIONS as OPTIONS };
