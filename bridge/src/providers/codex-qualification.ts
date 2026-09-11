import { CodexClient } from "./codex-client.ts";
import {
  CODEX_PERMISSION_PROFILE,
  CODEX_SCHEMA_VERSION,
  assertCodexConfigIsolated,
  type CodexExecutionPolicy,
} from "./codex-execution.ts";
import {
  parseAccountResult,
  parseConfigReadResult,
  parseModelListResult,
  parsePermissionProfileListResult,
  projectCodexModels,
  type CodexQualification,
} from "./codex-protocol.ts";

const versionFromUserAgent = (userAgent: string): string | undefined =>
  userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];

/** Zero-turn qualification. No thread or model turn is created by this method. */
export async function qualifyCodexRuntime(args: {
  client: CodexClient;
  policy: CodexExecutionPolicy;
}): Promise<CodexQualification> {
  const initialized = await args.client.connect();
  const version = versionFromUserAgent(initialized.userAgent);
  if (version !== CODEX_SCHEMA_VERSION) {
    throw new Error(
      `Codex ${version ?? "unknown"} is unsupported by the consumed protocol; install exactly ${CODEX_SCHEMA_VERSION}`,
    );
  }
  const account = await args.client.request({
    method: "account/read",
    params: { refreshToken: false },
    parse: parseAccountResult,
  });
  if (!account.account) throw new Error("Codex is not signed in; run `codex login`");
  if (account.account.type === "amazonBedrock") throw new Error("Codex Amazon Bedrock authentication is not qualified");
  const models = await args.client.request({
    method: "model/list", params: { includeHidden: false, limit: 100 }, parse: parseModelListResult,
  });
  if (models.nextCursor) throw new Error("Codex model catalog exceeds the bounded qualification page");
  const projectedModels = projectCodexModels(models);
  if (!projectedModels.length || projectedModels.some(model => !model.efforts.length)) {
    throw new Error("Codex has no qualified text/image model with advertised reasoning efforts");
  }
  const profiles = await args.client.request({
    method: "permissionProfile/list",
    params: { cwd: args.policy.dir, limit: 100 },
    parse: parsePermissionProfileListResult,
  });
  if (profiles.nextCursor) throw new Error("Codex permission profile list exceeds the bounded qualification page");
  const profile = profiles.data.find(item => item.id === CODEX_PERMISSION_PROFILE);
  if (!profile?.allowed) throw new Error(`Codex permission profile ${CODEX_PERMISSION_PROFILE} is unavailable`);
  const effective = await args.client.request({
    method: "config/read", params: { cwd: args.policy.dir, includeLayers: true }, parse: parseConfigReadResult,
  });
  assertCodexConfigIsolated({ result: effective, policy: args.policy });
  return { version, auth: account.account.type, models: projectedModels };
}
