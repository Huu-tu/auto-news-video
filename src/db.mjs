import postgres from "postgres";

let sql = null;

export function getSql() {
  if (sql) return sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — xem .env.example");

  sql = postgres(url, {
    max: 4,
    onnotice: () => {}, 
  });
  return sql;
}

export async function closeSql() {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

export async function initSchema(client = getSql()) {
  await client`
    CREATE TABLE IF NOT EXISTS schedule (
      id          bigserial PRIMARY KEY,
      name        text        NOT NULL,
      run_at      timestamptz NOT NULL,
      storyboard  text        NOT NULL,
      note        text        NOT NULL DEFAULT '',
      enabled     boolean     NOT NULL DEFAULT true,

      status      text        NOT NULL DEFAULT 'pending',
      attempts    int         NOT NULL DEFAULT 0,
      job_id      text,
      video_link  text,
      last_error  text,
      claimed_at  timestamptz,

      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`;

  await client`
    CREATE INDEX IF NOT EXISTS schedule_due_idx
      ON schedule (run_at) WHERE enabled AND status = 'pending'`;
}
