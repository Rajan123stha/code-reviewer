-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('running', 'completed', 'posted', 'failed');

-- CreateTable
CREATE TABLE "installations" (
    "id" SERIAL NOT NULL,
    "github_installation_id" BIGINT NOT NULL,
    "account" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" SERIAL NOT NULL,
    "installation_id" INTEGER NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "full_name" TEXT NOT NULL,
    "default_branch" TEXT,
    "last_indexed_sha" TEXT,
    "config_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" SERIAL NOT NULL,
    "repo_id" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "base_sha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "pr_id" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "config_hash" TEXT NOT NULL,
    "strategy_config_json" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "served_model" TEXT,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "prompt_version" TEXT NOT NULL,
    "prompt_hash" TEXT,
    "schema_name" TEXT,
    "status" "review_status" NOT NULL DEFAULT 'running',
    "error" TEXT,
    "context_stats_json" JSONB,
    "redactions_json" JSONB,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "latency_ms" INTEGER,
    "llm_attempts" INTEGER,
    "llm_request_id" TEXT,
    "github_review_id" BIGINT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_comments" (
    "id" SERIAL NOT NULL,
    "review_id" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "file_path" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggested_fix" TEXT,
    "body" TEXT NOT NULL,
    "llm_confidence" DOUBLE PRECISION NOT NULL,
    "filter_score" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "duplicate_of_index" INTEGER,
    "rank" INTEGER,
    "posted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "candidate_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_github_installation_id_key" ON "installations"("github_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_repo_id_key" ON "repositories"("github_repo_id");

-- CreateIndex
CREATE INDEX "repositories_installation_id_idx" ON "repositories"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repo_id_number_key" ON "pull_requests"("repo_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_pr_id_head_sha_config_hash_key" ON "reviews"("pr_id", "head_sha", "config_hash");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_comments_review_id_index_key" ON "candidate_comments"("review_id", "index");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_comments" ADD CONSTRAINT "candidate_comments_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
