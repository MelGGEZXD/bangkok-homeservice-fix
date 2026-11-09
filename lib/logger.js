// Structured JSON logging (pino). One logger instance, shared everywhere, so log shape is
// consistent whether it's app bootstrap, a request handler, or the background relay.
import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  base: { service: "edemand" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
