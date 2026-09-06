/**
 * TypeBox response schemas for spotlight async providers.
 *
 * One schema per HTTP endpoint. Every provider passes its schema to
 * `apiRequest` (`@core/http`), which validates the response body so the
 * provider code never does `as Foo` past a JSON boundary.
 *
 * §3 of the master plan: TypeBox at every untyped boundary.
 */
import { Type } from '@core/utils/typeboxHelpers'

// The media, data-table and data-row providers were deleted with the Content /
// Data / Media workspaces; their schemas went with them. What is left is the
// one provider in this file's remaining company that still fetches.

// ─── Plugins / plugin pages provider ─────────────────────────────────────────
// GET /admin/api/cms/plugins

const PluginAdminPageSummarySchema = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    navLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    route: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
)

const InstalledPluginSummarySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    enabled: Type.Boolean(),
    manifest: Type.Object(
      {
        adminPages: Type.Optional(Type.Array(PluginAdminPageSummarySchema)),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

export const PluginsListResponseSchema = Type.Object(
  { plugins: Type.Array(InstalledPluginSummarySchema) },
  { additionalProperties: true },
)
