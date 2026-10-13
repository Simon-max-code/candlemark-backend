CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "entry" DECIMAL(28,10) NOT NULL,
    "stopLoss" DECIMAL(28,10) NOT NULL,
    "takeProfit" DECIMAL(28,10) NOT NULL,
    "rationale" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Signal_status_createdAt_idx" ON "Signal"("status", "createdAt");
