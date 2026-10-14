import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  MAX_ORDERS_FILE_BYTES,
  OrderImportError,
  type NewOrder,
} from "../../../src/orders/csv-import.js";
import { importOrders } from "../../../src/orders/repository.js";
import { ROOT, runCli } from "../../helpers/cli.js";
import { createTestPool, resetDatabase } from "../../helpers/database.js";

const fixture = (name: string) => path.join(ROOT, "test/fixtures", name);

let pool: pg.Pool;

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

const PYG_ORDER: NewOrder = {
  orderRef: "ORD-1001",
  customerName: "María Benítez",
  amountMinor: 150000,
  currency: "PYG",
  createdAt: new Date("2026-10-10T12:00:00Z"),
};
const USD_ORDER: NewOrder = {
  orderRef: "ORD-1002",
  customerName: "Acosta, Rodrigo",
  amountMinor: 1234,
  currency: "USD",
  createdAt: new Date("2026-10-11T08:30:00Z"),
};
const ORDERS = [PYG_ORDER, USD_ORDER];

async function storedOrders() {
  const { rows } = await pool.query<{ order_ref: string } & Record<string, unknown>>(
    `SELECT order_ref, customer_name, amount_minor::text, currency, created_at
     FROM orders ORDER BY order_ref`,
  );
  return rows;
}

const STORED = [
  {
    order_ref: "ORD-1001",
    customer_name: "María Benítez",
    amount_minor: "150000",
    currency: "PYG",
    created_at: new Date("2026-10-10T12:00:00Z"),
  },
  {
    order_ref: "ORD-1002",
    customer_name: "Acosta, Rodrigo",
    amount_minor: "1234",
    currency: "USD",
    created_at: new Date("2026-10-11T08:30:00Z"),
  },
];

const importCli = (file: string) => runCli("src/orders/cli.ts", [fixture(file)]);

describe("importOrders", () => {
  it("stores every order with exact minor units and UTC timestamps", async () => {
    expect(await importOrders(pool, ORDERS)).toEqual({ inserted: 2, unchanged: 0 });
    expect(await storedOrders()).toEqual(STORED);
  });

  it("treats a re-import of identical orders as a no-op", async () => {
    await importOrders(pool, ORDERS);
    expect(await importOrders(pool, ORDERS)).toEqual({ inserted: 0, unchanged: 2 });
    expect(await storedOrders()).toEqual(STORED);
  });

  it("aborts the whole import when an existing reference has different values", async () => {
    await importOrders(pool, [PYG_ORDER]);
    const attempt = importOrders(pool, [USD_ORDER, { ...PYG_ORDER, amountMinor: 150001 }]);
    await expect(attempt).rejects.toThrow(OrderImportError);
    await expect(attempt).rejects.toThrow(
      'order_ref "ORD-1001" already exists with different values',
    );
    expect(await storedOrders()).toEqual(STORED.slice(0, 1));
  });
});

describe("npm run import:orders", () => {
  it("imports a file and reports a second run as unchanged", async () => {
    expect(await importCli("orders.csv")).toMatchObject({
      code: 0,
      stdout: "Imported 3 new orders, 0 unchanged.\n",
    });
    expect(await importCli("orders.csv")).toMatchObject({
      code: 0,
      stdout: "Imported 0 new orders, 3 unchanged.\n",
    });
    expect((await storedOrders()).map((order) => order.order_ref)).toEqual([
      "ORD-1001",
      "ORD-1002",
      "ORD-1003",
    ]);
  });

  it("exits 1 listing every problem and imports nothing", async () => {
    const result = await importCli("orders-invalid.csv");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('line 2: amount: Amount "12.345" has more decimals');
    expect(result.stderr).toContain('line 3: currency: Unsupported currency "EUR"');
    expect(await storedOrders()).toEqual([]);
  });

  it("exits 1 with a clear message when the file cannot be read", async () => {
    const result = await importCli("missing.csv");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot read");
    expect(result.stderr).not.toContain("    at ");
  });

  it("keeps the invalid byte in the UTF-8 fixture", async () => {
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(fixture("orders-invalid-utf8.csv"))).includes(0xff)).toBe(true);
  });

  it("rejects a file that is not valid UTF-8", async () => {
    const result = await importCli("orders-invalid-utf8.csv");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the file is not valid UTF-8");
    expect(await storedOrders()).toEqual([]);
  });

  it("rejects a file over the size cap", async () => {
    mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
    const dir = mkdtempSync(path.join(ROOT, ".tmp", "orders-"));
    try {
      const file = path.join(dir, "big.csv");
      writeFileSync(file, Buffer.alloc(MAX_ORDERS_FILE_BYTES + 1, "a"));
      const result = await runCli("src/orders/cli.ts", [file]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `the file is ${String(MAX_ORDERS_FILE_BYTES + 1)} bytes; the maximum is ${String(MAX_ORDERS_FILE_BYTES)}`,
      );
      expect(await storedOrders()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a path that is not a regular file instead of reading it", async () => {
    mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
    const dir = mkdtempSync(path.join(ROOT, ".tmp", "orders-"));
    try {
      // A FIFO reports size 0 and would block a read forever.
      const fifo = path.join(dir, "orders.fifo");
      execFileSync("mkfifo", [fifo]);
      const result = await runCli("src/orders/cli.ts", [fifo]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${fifo} is not a regular file`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
