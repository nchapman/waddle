import { initWorker } from "betterbase/db/worker";
import { snapshots } from "../lib/bb-collections.js";

initWorker([snapshots]);
