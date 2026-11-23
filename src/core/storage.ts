import type { Patient, ExamRecord } from '../types';

const DB_NAME = 'tcm-tongue-db';
const DB_VERSION = 1;
const STORE_PATIENTS = 'patients';
const STORE_RECORDS = 'records';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PATIENTS)) {
        db.createObjectStore(STORE_PATIENTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error);
      }),
  );
}

export function uid(prefix = 'id'): string {
  // 不用 Math.random：时间戳 + 随机后缀，唯一性足够且可复现测试
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ---------------- 病人 ----------------

export async function putPatient(p: Patient): Promise<void> {
  await tx(STORE_PATIENTS, 'readwrite', (s) => s.put(p));
}

export async function getAllPatients(): Promise<Patient[]> {
  const list = await tx<Patient[]>(STORE_PATIENTS, 'readonly', (s) => s.getAll() as IDBRequest<Patient[]>);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPatient(id: string): Promise<Patient | undefined> {
  return tx<Patient | undefined>(STORE_PATIENTS, 'readonly', (s) => s.get(id) as IDBRequest<Patient | undefined>);
}

export async function deletePatient(id: string): Promise<void> {
  await tx(STORE_PATIENTS, 'readwrite', (s) => s.delete(id));
  const records = await getRecordsByPatient(id);
  await Promise.all(records.map((r) => deleteRecord(r.id)));
}

// ---------------- 检查/随访记录 ----------------

export async function putRecord(r: ExamRecord): Promise<void> {
  await tx(STORE_RECORDS, 'readwrite', (s) => s.put(r));
}

export async function getRecordsByPatient(patientId: string): Promise<ExamRecord[]> {
  const db = await openDb();
  return new Promise<ExamRecord[]>((resolve, reject) => {
    const t = db.transaction(STORE_RECORDS, 'readonly');
    const idx = t.objectStore(STORE_RECORDS).index('patientId');
    const req = idx.getAll(patientId) as IDBRequest<ExamRecord[]>;
    req.onsuccess = (): void => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = (): void => reject(req.error);
  });
}

export async function getRecord(id: string): Promise<ExamRecord | undefined> {
  return tx<ExamRecord | undefined>(STORE_RECORDS, 'readonly', (s) => s.get(id) as IDBRequest<ExamRecord | undefined>);
}

export async function deleteRecord(id: string): Promise<void> {
  await tx(STORE_RECORDS, 'readwrite', (s) => s.delete(id));
}

/** 导出全部数据（JSON，供医院系统对接/备份） */
export async function exportAll(): Promise<{ patients: Patient[]; records: ExamRecord[]; exportedAt: number }> {
  const [patients, records] = await Promise.all([
    tx<Patient[]>(STORE_PATIENTS, 'readonly', (s) => s.getAll() as IDBRequest<Patient[]>),
    tx<ExamRecord[]>(STORE_RECORDS, 'readonly', (s) => s.getAll() as IDBRequest<ExamRecord[]>),
  ]);
  return { patients, records, exportedAt: Date.now() };
}
