import {StorageStats} from 'filecoin-network-stats-common/lib/domain/Stats';
import {TimeseriesDatapoint} from 'filecoin-network-stats-common/lib/domain/TimeseriesDatapoint';
import {HistogramDatapoint} from 'filecoin-network-stats-common/lib/domain/HistogramDatapoint';
import ChartDuration from 'filecoin-network-stats-common/lib/domain/ChartDuration';
import {CategoryDatapoint} from 'filecoin-network-stats-common/lib/domain/CategoryDatapoint';
import {MinerStat} from 'filecoin-network-stats-common/lib/domain/MinerStat';
import {CostCapacityForMinerStat} from 'filecoin-network-stats-common/lib/domain/CostCapacityForMinerStat';
import {Node} from 'filecoin-network-stats-common/lib/domain/Node';
import PGClient from '../PGClient';
import {PoolClient} from 'pg';
import BigNumber from 'bignumber.js';
import {INodeStatusService} from '../NodeStatusService';
import {generateDurationSeries} from '../../util/generateDurationSeries';
import {DEFAULT_CACHE_TIME, ICacheService} from '../CacheService';
import {IBlocksDAO} from './BlocksDAO';
import {Block} from '../../domain/Block';
import makeLogger from '../../util/logger';
import {SECTOR_SIZE_BYTES, SECTOR_SIZE_GB} from '../../Config';

const logger = makeLogger('StorageStatsDAO');

export interface IStorageStatsDAO {
  getStats (): Promise<StorageStats>

  getMinerStats (): Promise<MinerStat[]>

  historicalMinerCountStats (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  historicalStoragePrice (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  historicalCollateral (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  historicalCollateralPerGB (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  historicalStorageAmount (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  historicalUtilization (dur: ChartDuration): Promise<TimeseriesDatapoint[]>

  materializeUtilizationStats (): Promise<void>
}

interface BlockIndex {
  [k: string]: {
    blockPercentage: number
  }
}

const ONE_PB = 1000000;

export class PostgresStorageStatsDAO implements IStorageStatsDAO {
  private readonly client: PGClient;

  private readonly nss: INodeStatusService;

  private readonly cs: ICacheService;

  private readonly bsd: IBlocksDAO;

  constructor (client: PGClient, nss: INodeStatusService, cs: ICacheService, bsd: IBlocksDAO) {
    this.client = client;
    this.nss = nss;
    this.cs = cs;
    this.bsd = bsd;
  }

  async getStats() : Promise<StorageStats> {
    return this.client.execute(async (client: PoolClient) => {
      return {
        storageAmount: await this.cs.wrapMethod('storage-stats-storage-amount', DEFAULT_CACHE_TIME, () => this.getAmountStats(client)),
        storageCost: await this.cs.wrapMethod('storage-stats-storage-cost', DEFAULT_CACHE_TIME, () => this.getCostStats(client)),
        historicalCollateral: await this.cs.wrapMethod('storage-stats-historical-collateral', DEFAULT_CACHE_TIME, () => this.getHistoricalCollateral(client, ChartDuration.MONTH)),
        historicalCollateralPerGB: await this.cs.wrapMethod('storage-stats-historical-collateral-per-gb', DEFAULT_CACHE_TIME, () => this.getHistoricalCollateralPerGBStats()),
        historicalMinerCounts: await this.cs.wrapMethod('storage-stats-historical-miner-counts', DEFAULT_CACHE_TIME, () => this.getHistoricalMinerCounts(client, ChartDuration.MONTH)),
        capacityHistogram: await this.cs.wrapMethod('storage-stats-capacity-histogram', DEFAULT_CACHE_TIME, () => this.getCapacityHistogram(client)),
        miners: await this.getMiners(client),
        networkUtilization: await this.cs.wrapMethod('storage-stats-network-utilization', DEFAULT_CACHE_TIME, () => this.getHistoricalUtilization(client, ChartDuration.MONTH)),
        distributionOverTime: await this.cs.wrapMethod('storage-stats-distribution-over-time', DEFAULT_CACHE_TIME, () => this.getMiningDistributionOverTime(client)),
        evolution: await this.cs.wrapMethod('storage-stats-evolution', DEFAULT_CACHE_TIME, () => this.getMiningEvolution(client)),
        costCapacityBySize: [
          await this.cs.wrapMethod('storage-stats-cost-capacity-0', DEFAULT_CACHE_TIME, () => this.getCostCapacityBySize(client, ONE_PB, 'lt')),
          await this.cs.wrapMethod('storage-stats-cost-capacity-1', DEFAULT_CACHE_TIME, () => this.getCostCapacityBySize(client, ONE_PB, 'gte')),
        ],
      };
    });
  };

  getMinerStats (): Promise<MinerStat[]> {
    return this.client.execute((client: PoolClient) => this.getMiners(client));
  }

  getHistoricalCollateralPerGBStats() {
    return this.client.execute(async (client: PoolClient) => {
      const data = await this.getHistoricalCollateralPerGB(client, ChartDuration.MONTH);

      const average = await client.query(`
        WITH m AS (SELECT sum(m.value)                                                       AS collateral,
                          sum(cast(m.params->>0 AS bigint)) * ${SECTOR_SIZE_GB}              AS gb,
                          extract(EPOCH FROM date_trunc('day', to_timestamp(b.ingested_at))) AS date
                   FROM messages m
                          JOIN blocks b ON m.height = b.height
                   WHERE m.method = 'createMiner'
                   GROUP BY date),
             amounts AS (SELECT m.date,
                                coalesce(m.collateral, 0) AS collateral,
                                coalesce(gb, 0)           AS gb,
                                (CASE
                                   WHEN gb > 0 THEN collateral / gb
                                   ELSE 0 END)            AS amount
                         FROM m)
        SELECT avg(a.amount) AS avg
        FROM amounts a;
      `);

      return {
        data: data,
        average: new BigNumber(average.rows[0].avg),
      };
    });
  }

  historicalMinerCountStats (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalMinerCounts(client, dur));
  }

  historicalStoragePrice (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalStoragePrice(client, dur));
  }

  historicalCollateral (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalCollateral(client, dur));
  }

  historicalCollateralPerGB (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalCollateralPerGB(client, dur));
  }

  historicalStorageAmount (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalStorageAmount(client, dur));
  }

  historicalUtilization (dur: ChartDuration): Promise<TimeseriesDatapoint[]> {
    return this.client.execute((client: PoolClient) => this.getHistoricalUtilization(client, dur));
  }

  materializeUtilizationStats (): Promise<void> {
    return this.client.executeTx((client: PoolClient) => client.query(`
      WITH total_sectors AS (SELECT sum(s.commitments) AS total
                             FROM (SELECT count(DISTINCT m.params->>0) AS commitments
                                   FROM messages m
                                   WHERE method = 'commitSector'
                                   GROUP BY m.to_address) s),
           total_pledges AS (SELECT sum(cast(m.params->>0 AS integer)) AS total
                             FROM messages m
                             WHERE method = 'createMiner'),
           vals AS (SELECT coalesce(s.total * ${SECTOR_SIZE_GB}, 0) AS total_committed_gb,
                           coalesce(p.total * ${SECTOR_SIZE_GB}, 0) AS total_pledges_gb,
                           extract(EPOCH FROM current_timestamp)
                    FROM total_sectors s,
                         total_pledges p)
      INSERT INTO network_usage_stats (total_committed_gb, total_pledges_gb, calculated_at)
      SELECT *
      FROM vals;
    `) as Promise<any>);
  }

  private async getHistoricalStorageAmount (client: PoolClient, duration: ChartDuration): Promise<TimeseriesDatapoint[]> {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const points = await client.query(`
      WITH seq AS (${durSeq}),
           grp AS (SELECT max(coalesce(total_pledges_gb, 0)) AS amount, seq.date AS date
                   FROM seq
                          LEFT OUTER JOIN network_usage_stats m
                            ON seq.date = extract(EPOCH FROM date_trunc('${durBase}', to_timestamp(m.calculated_at)))
                   GROUP BY seq.date
                   ORDER BY date ASC)
      SELECT (CASE
                WHEN g.amount = 0 THEN max(g.amount::integer) OVER w
                ELSE g.amount END) AS amount, g.date
      FROM grp g WINDOW w AS (ORDER BY g.date)
      ORDER BY g.date ASC;
    `);

    return this.inflateTimeseriesDatapoints(points.rows);
  }

  private async getAmountStats (client: PoolClient) {
    const data = await this.getHistoricalStorageAmount(client, ChartDuration.MONTH);
    let total = new BigNumber(0);
    if (data.length) {
      total = data[data.length - 1].amount;
    }

    const trend = this.calculateTrend(data);

    return {
      total,
      trend,
      data,
    };
  }

  private async getCostStats (client: PoolClient) {
    const data = await this.getHistoricalStoragePrice(client, ChartDuration.MONTH);

    const avgRes = await client.query(`
      SELECT coalesce(avg(a.price), 0) / 1000000000000000000 AS avg
      FROM asks a
             JOIN messages m ON a.message_id = m.id
             JOIN blocks b ON b.height = m.height
      WHERE b.ingested_at > extract(EPOCH FROM (date_trunc('day', current_timestamp) - INTERVAL '30 days'));
    `);

    const average = new BigNumber(avgRes.rows[0].avg);

    const trend = this.calculateTrend(data);

    return {
      average,
      trend,
      data,
    };
  }

  private async getHistoricalStoragePrice (client: PoolClient, duration: ChartDuration): Promise<TimeseriesDatapoint[]> {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const points = await client.query(`
      with d as (${durSeq}),
           a as (select avg(a.price) as avg, extract(epoch from date_trunc('${durBase}', to_timestamp(b.ingested_at))) as date
                 from asks a
                        join messages m on a.message_id = m.id
                        join blocks b on b.height = m.height
                 group by date)
      select d.date, coalesce(a.avg, 0) / 1000000000000000000 as amount
      from d
             left outer join a on a.date = d.date
      order by d.date asc;
    `);

    return this.inflateTimeseriesDatapoints(points.rows);
  }

  private async getHistoricalCollateral (client: PoolClient, duration: ChartDuration) {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const dailyPoints = await client.query(`
      with d as (${durSeq}),
           m as (select sum(m.value)                                                       as amount,
                        extract(epoch from date_trunc('${durBase}', to_timestamp(b.ingested_at))) as date
                 from messages m
                        join blocks b on m.height = b.height
                 where m.method = 'createMiner'
                 group by date)
      select d.date as date, sum(coalesce(amount, 0)) over (order by d.date asc) as amount
      from d
             left outer join m on d.date = m.date
      order by date asc;
    `);

    return this.inflateTimeseriesDatapoints(dailyPoints.rows);
  }

  private async getHistoricalCollateralPerGB (client: PoolClient, duration: ChartDuration) {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const dailyPoints = await client.query(`
      with d as (${durSeq}),
           m as (select sum(m.value)                                                              as collateral,
                        sum(cast(m.params->>0 as bigint)) * ${SECTOR_SIZE_GB}                     as gb,
                        extract(epoch from date_trunc('${durBase}', to_timestamp(b.ingested_at))) as date
                 from messages m
                        join blocks b on m.height = b.height
                 where m.method = 'createMiner'
                 group by date)
      select d.date,
             coalesce(m.collateral, 0) as collateral,
             coalesce(gb, 0)           as gb,
             (case
                when gb > 0 then collateral / gb
                else 0 end)            as amount
      from d
             left outer join m on d.date = m.date
      order by date asc;
    `);

    return this.inflateTimeseriesDatapoints(dailyPoints.rows);
  }

  private async getHistoricalMinerCounts (client: PoolClient, duration: ChartDuration) {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const points = await client.query(`
      WITH seq AS (${durSeq})
      SELECT max(coalesce(count, 0)) AS amount, seq.date AS date
      FROM seq
             LEFT OUTER JOIN miner_counts m
               ON seq.date = extract(EPOCH FROM date_trunc('${durBase}', to_timestamp(m.calculated_at)))
      GROUP BY seq.date
      ORDER BY date ASC;
    `);

    return this.inflateTimeseriesDatapoints(points.rows);
  }

  private async getCapacityHistogram (client: PoolClient) {
    const increment = 10000;
    const bucketCount = 10;

    const points = await client.query(`
      WITH series AS (SELECT g.n, 1 + (${increment} * (g.n - 1)) AS bucket_start, (${increment} * (g.n - 1)) + ${increment} AS bucket_end
                      FROM generate_series(1, ${bucketCount - 1}, 1) g (n)),
           miners AS (SELECT p.*, bucket
                      FROM miners p,
                           width_bucket(p.amount, 1, ${increment * (bucketCount - 1)}, ${bucketCount - 1}) AS bucket)
      SELECT s.n, s.bucket_start, s.bucket_end, count(p)
      FROM series s
             LEFT OUTER JOIN miners p ON p.bucket = s.n
      GROUP BY s.n, s.bucket_start, s.bucket_end
      UNION ALL
      SELECT 10 AS n, ${(increment * (bucketCount - 1)) + 1} AS bucket_start, 0 AS bucket_end, count(m)
      FROM miners m
      WHERE m.amount >= ${(increment * (bucketCount - 1)) + 1}
      ORDER BY n ASC;
    `);

    return this.inflateHistogramDatapoint(points.rows);
  }

  private async getMiners (client: PoolClient) {
    const nodes = await this.nss.listMiners();
    const addresses = nodes.map((m: Node) => m.minerAddress);

    const topBlock = await this.bsd.top();
    const topBlockNumber = topBlock.height;

    const blockNums = new Set<number>();
    blockNums.add(topBlockNumber);
    for (const node of nodes) {
      blockNums.add(node.height > topBlockNumber ? topBlockNumber : node.height);
    }
    const blockNumsArray = Array.from(blockNums);
    const blocks = await this.bsd.byHeights(blockNumsArray);
    const blockIdx: {[n: number]: Block} = {};
    for (const block of blocks) {
      blockIdx[block.height] = block;
    }

    const minerDataRes = await client.query(`
      WITH miners_blocks AS (SELECT b.miner                                             AS address,
                                    max(b.height)                                       AS last_block_mined,
                                    (count(*)::decimal / (SELECT count(*) FROM blocks)) AS block_percentage
                             FROM blocks b
                             WHERE b.miner = ANY($1::varchar[])
                             GROUP BY b.miner)
      SELECT mb.*, m.amount, b.parent_hashes, b.ingested_at AS last_block_time
      FROM miners_blocks mb
             JOIN blocks b ON b.height = mb.last_block_mined
             JOIN miners m ON m.miner_address = mb.address;
    `, [
      addresses,
    ]);
    const index = minerDataRes.rows.reduce((acc: BlockIndex, curr: any) => {
      acc[curr.address] = {
        blockPercentage: curr.block_percentage,
      };
      return acc;
    }, {} as BlockIndex);

    const ret: MinerStat[] = [];
    for (const node of nodes) {
      const block = blockIdx[node.height > topBlockNumber ? topBlockNumber : node.height];
      if (!block) {
        logger.warn('no block found for node', {
          peerId: node.peerId,
          nickname: node.nickname,
          minerAddress: node.minerAddress,
          topBlockNumber,
          height: node.height,
        });
        continue;
      }

      const indexed = index[node.minerAddress];

      ret.push({
        nickname: node.nickname,
        address: node.minerAddress,
        peerId: node.peerId,
        parentHashes: block.parents,
        power: node.power,
        capacity: node.capacity,
        blockPercentage: indexed ? indexed.blockPercentage : 0,
        blockHeight: block.height,
        blockTime: block.ingestedAt,
        isInConsensus: node.height >= topBlockNumber,
        lastSeen: node.lastSeen
      });
    }

    return ret;
  }

  private async getHistoricalUtilization (client: PoolClient, duration: ChartDuration): Promise<TimeseriesDatapoint[]> {
    const {durSeq, durBase} = generateDurationSeries(duration);

    const points = await client.query(`
      WITH seq AS (${durSeq})
      SELECT (CASE
                WHEN max(n.total_pledges_gb) IS NULL THEN 0
                ELSE coalesce(max(n.total_committed_gb), 0) / max(n.total_pledges_gb)::decimal END) AS amount,
             seq.date                                                                                   AS date
      FROM seq
             LEFT OUTER JOIN network_usage_stats n
               ON seq.date = extract(EPOCH FROM date_trunc('${durBase}', to_timestamp(n.calculated_at)))
      GROUP BY seq.date
      ORDER BY date ASC;
    `);

    return this.inflateTimeseriesDatapoints(points.rows);
  }

  private async getMiningDistributionOverTime (client: PoolClient) {
    const intervals = [1, 7, 30];
    const ret: CategoryDatapoint[] = [];

    for (const interval of intervals) {
      const res = await client.query(`
        SELECT b.miner AS address, (count(*)::decimal / (SELECT count(*) FROM blocks)) AS percentage
        FROM blocks b
        WHERE b.miner != ''
          AND b.ingested_at > extract(EPOCH FROM current_timestamp - INTERVAL '${interval} day')
        GROUP BY b.miner
        ORDER BY percentage DESC
        LIMIT 4;
      `);

      const category = `${interval} day${interval > 1 ? 's' : ''}`;
      if (!res.rows.length) {
        ret.push({
          category,
          data: {},
        });
      }

      const data: { [k: string]: BigNumber } = {};
      let accumulator = new BigNumber(0);
      for (const row of res.rows) {
        const minerNode = await this.nss.getMinerByAddress(row.address);
        const point = minerNode ? minerNode.nickname : row.address;
        const percentage = new BigNumber(row.percentage);
        data[point] = percentage;
        accumulator = accumulator.plus(row.percentage);
      }

      data['Other'] = new BigNumber(1).minus(accumulator);
      ret.push({
        category,
        data,
      });
    }

    return ret;
  }

  private async getMiningEvolution (client: PoolClient) {
    const topMinerRes = await client.query(`
      SELECT b.miner AS address, (count(*)::decimal / (SELECT count(*) FROM blocks)) AS percentage
      FROM blocks b
      WHERE b.miner != ''
        AND b.ingested_at > extract(EPOCH FROM current_timestamp - INTERVAL '30 day')
      GROUP BY b.miner
      ORDER BY percentage DESC
      LIMIT 10;
    `);

    if (!topMinerRes.rows.length) {
      return [];
    }

    const addresses = topMinerRes.rows.map((r: any) => r.address);
    const seenNicks = new Set<string>();
    const addressesToNicks: {[k: string]: string} = {};
    for (const address of addresses) {
      const node = await this.nss.getMinerByAddress(address);
      if (node && node.nickname) {
        const nick = seenNicks.has(node.nickname) ? `${node.nickname} (${address.slice(-4)})` :
          node.nickname;
        seenNicks.add(node.nickname);
        addressesToNicks[address] = nick;
      } else {
        addressesToNicks[address] = address;
      }
    }

    const topDailyCountsRes = await client.query(`
      with totals as (select count(*), extract(epoch from date_trunc('day', to_timestamp(b.ingested_at))) as date
                      from blocks b
                      group by date),
           counts as (select b.miner                                                            as address,
                             count(*)                                                           as count,
                             extract(epoch from date_trunc('day', to_timestamp(b.ingested_at))) as date
                      from blocks b
                      where b.miner = ANY($1::varchar[])
                      group by b.miner, date)
      select c.address, c.count::decimal / t.count as percentage, c.date
      from counts c
             join totals t on c.date = t.date
      order by c.date asc;
    `, [
      addresses,
    ]);


    type CategoryDatapointData = { [k: string]: number }
    const generateData = () => addresses.reduce((acc: CategoryDatapointData, curr: string) => {
      acc[addressesToNicks[curr]] = 0;
      return acc;
    }, {});

    const points: CategoryDatapoint[] = [];

    for (const dailyCount of topDailyCountsRes.rows) {
      if (!points.length || points[points.length - 1].category !== Number(dailyCount.date)) {
        points.push({
          category: Number(dailyCount.date),
          data: generateData(),
        });
      }

      const cat = points[points.length - 1];
      cat.data[addressesToNicks[dailyCount.address]] = new BigNumber(dailyCount.percentage);
    }

    let date = Number(points[0].category);
    if (points.length < 2) {
      while (points.length < 2) {
        date = date - 86400;
        points.unshift({
          category: date,
          data: generateData(),
        });
      }
    }

    return points;
  }

  private async getCostCapacityBySize (client: PoolClient, size: number, op: 'lt' | 'gte'): Promise<CostCapacityForMinerStat> {
    const countCapRes = await client.query(`
      with capacities as (select m.from_address as address, sum(cast(m.params->>0 as decimal)) * ${SECTOR_SIZE_GB} as gb
                          from messages m
                          where m.method = 'createMiner'
                          group by m.from_address)
      select count(c) as count, avg(c.gb) as capacity
      from capacities c
      where c.gb ${op === 'lt' ? '<' : '>='} $1; 
    `, [
      size,
    ]);

    if (!countCapRes.rows.length) {
      return {
        count: 0,
        averageStoragePrice: new BigNumber(0),
        averageCapacityGB: 0,
        utilization: 0,
      };
    }

    const priceRes = await client.query(`
      with capacities as (select m.from_address as address, sum(cast(m.params->>0 as decimal)) * ${SECTOR_SIZE_GB} as gb
                          from messages m
                          where m.method = 'createMiner'
                          group by m.from_address)
      select coalesce(avg(price), 0) as price
      from asks a
             join messages m on m.id = a.message_id
      where exists(select 1
                   from capacities c
                   where c.gb ${op === 'lt' ? '<' : '>='} $1
                     and c.address = m.from_address);
    `, [
      size,
    ]);

    const utilizationRes = await client.query(`
      WITH capacities AS (SELECT m.from_address AS address, sum(cast(m.params->>0 AS decimal)) * ${SECTOR_SIZE_GB} AS gb
                          FROM messages m
                          WHERE m.method = 'createMiner'
                          GROUP BY m.from_address),
           commitments AS (SELECT m.from_address                     AS address,
                                  sum(cast(m.params->>0 AS decimal)) AS committed_gb,
                                  max(c.gb)                          AS pledged_gb
                           FROM messages m
                                  JOIN capacities c ON m.from_address = c.address
                           WHERE m.method = 'commitSector'
                             AND c.gb ${op === 'lt' ? '<' : '>='} $1
                           GROUP BY m.from_address)
      SELECT coalesce(avg(c.committed_gb / c.pledged_gb), 0) AS utilization
      FROM commitments c;
    `, [
      size,
    ]);

    const price = priceRes.rows.length ? priceRes.rows[0].price : 0;
    const utilization = utilizationRes.rows.length ? Number(utilizationRes.rows[0].utilization) : 0;
    return {
      count: Number(countCapRes.rows[0].count),
      averageCapacityGB: Number(countCapRes.rows[0].capacity),
      averageStoragePrice: new BigNumber(price),
      utilization,
    };
  }

  private inflateHistogramDatapoint (rows: any[]): HistogramDatapoint[] {
    return rows.map((r: any) => ({
      n: Number(r.n),
      bucketStart: new BigNumber(r.bucket_start),
      bucketEnd: new BigNumber(r.bucket_end),
      count: Number(r.count),
    }));
  }

  private inflateTimeseriesDatapoints (rows: any[]): TimeseriesDatapoint[] {
    return rows.map((r: any) => ({
      date: Number(r.date),
      amount: new BigNumber(r.amount),
    }));
  }

  private calculateTrend (points: TimeseriesDatapoint[]): number {
    let trend;
    const ultimate = points[points.length - 1];
    const penultimate = points[points.length - 2];

    if (penultimate && penultimate.amount.gt(0)) {
      const diff = ultimate.amount.minus(penultimate.amount);
      trend = diff.div(penultimate.amount).toNumber();
    } else {
      trend = ultimate.amount.gt(0) ? 1 : 0;
    }

    return trend;
  }
}