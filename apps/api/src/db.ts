import { Pool } from "pg";

export type Queryable = { query: Pool["query"] };
