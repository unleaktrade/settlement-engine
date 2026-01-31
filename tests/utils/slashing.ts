import * as anchor from "@coral-xyz/anchor";

export const expectedSlashedAmount = (rfq: any, includeSelected: boolean) => {
    const committed = Number(rfq.committedCount);
    const revealed = Number(rfq.revealedCount);
    const base = committed - revealed;
    if (base < 0) {
        throw new Error("invalid committed/revealed counts");
    }
    const total = includeSelected ? base + 1 : base;
    return rfq.bondAmount.muln(total);
};
