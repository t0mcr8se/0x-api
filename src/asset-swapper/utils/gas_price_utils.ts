import * as heartbeats from 'heartbeats';
import axios from 'axios';

import { constants } from '../constants';


const MAX_ERROR_COUNT = 5;

interface GasPrices {
    // gas price in wei
    fast: number;
    l1CalldataPricePerUnit?: number;
}


interface FuseExplorerResponse {
    gas_prices: {
        average: number;
        fast: number;
        slow: number;
    };
}

export class GasPriceUtils {
    private static _instances = new Map<string, GasPriceUtils>();
    private readonly _zeroExGasApiUrl: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: fix me!
    private readonly _gasPriceHeart: any;
    private _gasPriceEstimation: GasPrices | undefined;
    private _errorCount = 0;

    public static getInstance(
        gasPricePollingIntervalInMs: number,
        zeroExGasApiUrl: string = constants.ZERO_EX_GAS_API_URL,
    ): GasPriceUtils {
        if (!GasPriceUtils._instances.has(zeroExGasApiUrl)) {
            GasPriceUtils._instances.set(
                zeroExGasApiUrl,
                new GasPriceUtils(gasPricePollingIntervalInMs, zeroExGasApiUrl),
            );
        }

        const instance = GasPriceUtils._instances.get(zeroExGasApiUrl);
        if (instance === undefined) {
            // should not be reachable
            throw new Error(`Singleton for ${zeroExGasApiUrl} was not initialized`);
        }

        return instance;
    }

    public async getGasPriceEstimationOrDefault(defaultGasPrices: GasPrices): Promise<GasPrices> {
        if (this._gasPriceEstimation === undefined) {
            return defaultGasPrices;
        }

        return {
            ...defaultGasPrices,
            ...this._gasPriceEstimation,
        };
    }

    /** @returns gas price (in wei) */
    public async getGasPriceEstimationOrThrowAsync(): Promise<GasPrices> {
        if (this._gasPriceEstimation === undefined) {
            await this._updateGasPriceFromOracleOrThrow();
        }
        // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
        return this._gasPriceEstimation!;
    }

    /**
     * Destroys any subscriptions or connections.
     */
    public async destroyAsync(): Promise<void> {
        this._gasPriceHeart.kill();
    }

    private constructor(gasPricePollingIntervalInMs: number, zeroExGasApiUrl: string) {
        this._gasPriceHeart = heartbeats.createHeart(gasPricePollingIntervalInMs);
        this._zeroExGasApiUrl = zeroExGasApiUrl;
        this._initializeHeartBeat();
    }

    private async _updateGasPriceFromOracleOrThrow(): Promise<void> {
        try {
            await this._fetchGasPriceFromFuseExplorer();
        } catch (explorerError) {
            console.error('Fuse Explorer failed:', explorerError.message);
            try {
                await this._fetchGasPriceFromRpc();
            } catch (rpcError) {
                console.error('RPC fallback failed:', rpcError.message);
                this._handleGasPriceError(rpcError);
            }
        }
    }

    private async _fetchGasPriceFromFuseExplorer(): Promise<void> {
        const explorerApiKey = process.env.FUSE_EXPLORER_API_KEY;
        if (!explorerApiKey) {
            throw new Error('FUSE_EXPLORER_API_KEY is not set');
        }
        const url = `https://explorer.fuse.io/api/v2/stats?apikey=${explorerApiKey}`;
        const response = await axios.get(url);
        const stats: FuseExplorerResponse = response.data;
        this._setGasPrice(stats.gas_prices.fast);

    }

    private async _fetchGasPriceFromRpc(): Promise<void> {
        const nodeRpcUrl = process.env.NODE_RPC_URL;
        if (!nodeRpcUrl) {
            throw new Error('NODE_RPC_URL is not set');
        }
        const response = await axios.post(nodeRpcUrl, {
            jsonrpc: '2.0',
            method: 'eth_gasPrice',
            params: [],
            id: 1,
        });
        const rpcData = response.data;
        if (rpcData.error) {
            throw new Error(`RPC Error: ${rpcData.error.message}`);
        }
        const gasPriceInWei = parseInt(rpcData.result, 16);
        this._setGasPrice(gasPriceInWei);
    }

    private _setGasPrice(gasPriceInWei: number): void {
        this._gasPriceEstimation = {
            fast: gasPriceInWei,
            l1CalldataPricePerUnit: gasPriceInWei,
        };
        this._errorCount = 0;
    }

    private _handleGasPriceError(error: Error): void {
        this._errorCount++;
        if (this._errorCount > MAX_ERROR_COUNT || this._gasPriceEstimation === undefined) {
            this._errorCount = 0;
            throw new Error(`Gas price estimation failed: ${error.message}`);
        }
    }

    private _initializeHeartBeat(): void {
        this._gasPriceHeart.createEvent(1, async () => {
            await this._updateGasPriceFromOracleOrThrow();
        });
    }
}
