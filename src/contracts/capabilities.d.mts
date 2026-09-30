import type { z } from "zod";

export type CapabilityCategory = "visual" | "media" | "animation" | "audio";
export type CapabilityKind =
  | "composition"
  | "renderer"
  | "asset-adapter"
  | "asset-source"
  | "helper-library"
  | "generator-adapter"
  | "processor";
export type CapabilitySeek = "absolute" | "author" | "decoded";
export interface CapabilityReference {
  key: string;
  path: string;
}
export interface AuthoringCapability {
  id: string;
  name: string;
  category: CapabilityCategory;
  kind: CapabilityKind;
  package?: string;
  description: string;
  integration: {
    entry: string;
    module: string;
    projectEntry?: string;
    sourceKind?: string;
    processorType?: string;
    helpers?: { entry: string; module: string; description: string }[];
  };
  supports: {
    template?: boolean;
    seek?: CapabilitySeek;
    alpha?: boolean;
    offline?: boolean;
    realtime?: boolean;
    canvasLayer?: boolean;
    rootComposition?: boolean;
  };
  requirements: string[];
  reference: CapabilityReference;
  sources: string[];
}
export interface CapabilityMixing {
  id: string;
  description: string;
  requirements: string[];
  reference: CapabilityReference;
}
export interface CapabilityDiscovery {
  localCLI: string;
  mcp: string;
  agent: string;
  reference: string;
}
export interface AuthoringCapabilities {
  schemaVersion: 1;
  defaultRenderer: "composition";
  categories: CapabilityCategory[];
  items: AuthoringCapability[];
  mixing: CapabilityMixing[];
  selection: { neutral: true; description: string; readiness: string };
  discovery: CapabilityDiscovery;
}
export interface CapabilityFilters {
  category?: CapabilityCategory;
  query?: string;
  id?: string;
}
export const capabilityCategories: readonly CapabilityCategory[];
export const capabilityFilterShape: {
  category: z.ZodType<CapabilityCategory | undefined>;
  query: z.ZodType<string | undefined>;
  id: z.ZodType<string | undefined>;
};
export function getAuthoringCapabilities(
  options?: CapabilityFilters,
): AuthoringCapabilities;
export interface AuthoringCapabilitySummary {
  schemaVersion: 1;
  defaultRenderer: "composition";
  groups: Record<
    CapabilityCategory,
    Pick<AuthoringCapability, "id" | "name" | "kind">[]
  >;
  mixing: Pick<CapabilityMixing, "id" | "description">[];
  selection: string;
  discovery: CapabilityDiscovery;
}
export function authoringCapabilitySummary(): AuthoringCapabilitySummary;
export function renderCapabilityOverview(): string;
