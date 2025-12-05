import * as anchor from "@coral-xyz/anchor";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const getChainUnixTime = async (connection: anchor.web3.Connection) => {
    const slot = await connection.getSlot();
    const ts = await connection.getBlockTime(slot);
    if (ts === null) {
        throw new Error("block time unavailable");
    }
    return ts;
};

export const waitForChainTime = async (
    connection: anchor.web3.Connection,
    targetTs: number,
    label: string,
) => {
    let now = await getChainUnixTime(connection);
    while (now <= targetTs) {
        const remainingMs = (targetTs - now + 1) * 1_000;
        const waitMs = Math.min(1_000, remainingMs);
        console.log(`${label}: waiting ${waitMs}ms (now=${now}, target=${targetTs})`);
        await sleep(waitMs);
        now = await getChainUnixTime(connection);
    }
};
