import { initWorker } from "betterbase/db/worker";
import { machines } from "../lib/bb-collections.js";

initWorker([machines]);
