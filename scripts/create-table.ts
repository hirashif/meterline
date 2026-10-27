import { TABLE_NAME, makeDocClient } from "../src/db.js";
import { createTable } from "../src/table.js";

await createTable(makeDocClient(), TABLE_NAME);
console.log(`table ${TABLE_NAME} ready`);
