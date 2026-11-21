// verify's API half (spec 01 §4.4, §7.2; ARCHITECTURE §7.12): it answers verify.<zone>/api/* and
// selfie.<zone>/api/* and its private health, behind the shared front door. FIN_PUBLIC_ORIGIN is a
// JSON object of both origins; each host has its own ingress proof, and the origin gate holds each
// request to its own host's origin. verify runs no Better Auth: it has no /api/auth routes and sets
// only its own two cookies (the hosted-link lane adds them on Sunday). Its JSON routes are Hono
// routes at basePath("/api").
import type { ServiceDefinition } from "@fin/server";
import { defineApiService } from "@fin/web-host";

export const verifyService: ServiceDefinition = defineApiService("verify");
