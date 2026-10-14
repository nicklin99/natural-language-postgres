import { createWorkBuddyCloud, createMemoryStorage } from '@tencent-ai/workbuddy-cloud-sdk';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import 'dotenv/config';

const TABLE_NAME = 'unicorns';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS unicorns (
  id SERIAL PRIMARY KEY,
  company VARCHAR(255) NOT NULL UNIQUE,
  valuation DECIMAL(10, 2) NOT NULL,
  date_joined DATE,
  country VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL,
  industry VARCHAR(255) NOT NULL,
  select_investors TEXT NOT NULL
);
`;

function parseDate(dateString: string): string {
  const parts = dateString.split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    return `${year}-${month}-${day}`;
  }
  console.warn(`Could not parse date: ${dateString}`);
  throw new Error(`Could not parse date: ${dateString}`);
}

function readCsvRows(csvFilePath: string): Promise<any[]> {
  const results: any[] = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

export async function seed() {
  const endpoint = process.env.WORKBUDDY_ENDPOINT;
  const publishableKey = process.env.WORKBUDDY_PUBLISHABLE_KEY;

  if (!endpoint || !publishableKey) {
    throw new Error(
      'WORKBUDDY_ENDPOINT and WORKBUDDY_PUBLISHABLE_KEY are required in .env',
    );
  }

  const cloud = createWorkBuddyCloud({
    endpoint,
    publishableKey,
    storage: createMemoryStorage(),
  });

  // 可选：数据库写权限受 RLS 保护时，先登录再写入
  const email = process.env.WORKBUDDY_EMAIL;
  const password = process.env.WORKBUDDY_PASSWORD;
  if (email && password) {
    const { error: signInError } = await cloud.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    console.log('Signed in as', email);
  }

  // PostgREST 语义的 SDK 不支持 DDL，先探测表是否存在
  const { error: checkError } = await cloud.database
    .from(TABLE_NAME)
    .select('id')
    .limit(1);

  if (checkError) {
    if (checkError.message.includes('relation') || checkError.message.includes('not found')) {
      console.error(
        `Table "${TABLE_NAME}" does not exist yet. PostgREST cannot run DDL, ` +
          'so create it in the WorkBuddy console / SQL editor first:',
      );
      console.error(CREATE_TABLE_SQL);
      throw checkError;
    }
    throw checkError;
  }

  console.log(`Table "${TABLE_NAME}" exists`);

  const csvFilePath = path.join(process.cwd(), 'unicorns.csv');
  const results = await readCsvRows(csvFilePath);

  const rows = results.map((row) => ({
    company: row.Company,
    valuation: parseFloat(row['Valuation ($B)'].replace('$', '').replace(',', '')),
    date_joined: parseDate(row['Date Joined']),
    country: row.Country,
    city: row.City,
    industry: row.Industry,
    select_investors: row['Select Investors'],
  }));

  // 分批 upsert，等价于原 ON CONFLICT (company) DO NOTHING
  const BATCH_SIZE = 200;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: upsertError } = await cloud.database
      .from(TABLE_NAME)
      .upsert(batch, { onConflict: 'company', ignoreDuplicates: true });

    if (upsertError) {
      console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, upsertError.message);
      throw upsertError;
    }
    inserted += batch.length;
    console.log(`Seeded ${inserted} / ${rows.length}`);
  }

  console.log(`Seeded ${rows.length} unicorns via WorkBuddy Cloud SDK`);

  return { cloud, rows };
}

seed().catch(console.error);
