// The monitoring commands (spec 08 §7.11, spec 01 §8).

import type { Command } from "../command.ts";
import { monitoringApply } from "../monitoring/apply.ts";

export const MONITORING_COMMANDS: readonly Command[] = [monitoringApply];
