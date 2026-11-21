// The Railway and static deploy commands (spec 01 §6.8, §6.9, §7.4; BD-16).

import type { Command } from "../command.ts";
import { railwayDeploy } from "../railway/deploy.ts";
import { railwayVerify } from "../railway/verify.ts";
import { staticDeploy } from "../static/deploy.ts";
import { staticRender } from "../static/render.ts";

export const DEPLOY_COMMANDS: readonly Command[] = [
  railwayVerify,
  railwayDeploy,
  staticRender,
  staticDeploy,
];
