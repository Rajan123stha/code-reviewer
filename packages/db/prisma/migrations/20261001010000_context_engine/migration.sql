-- CreateTable
CREATE TABLE "parsed_blobs" (
    "key" TEXT NOT NULL,
    "parse" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parsed_blobs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "repo_id" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "blob_hash" TEXT NOT NULL,
    "parser_version" INTEGER NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbols" (
    "id" SERIAL NOT NULL,
    "file_id" INTEGER NOT NULL,
    "local_index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "qualified_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "exported" BOOLEAN NOT NULL,
    "parent_symbol_id" INTEGER,

    CONSTRAINT "symbols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edges" (
    "id" SERIAL NOT NULL,
    "repo_id" INTEGER NOT NULL,
    "src_symbol_id" INTEGER NOT NULL,
    "dst_symbol_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_repo_id_path_key" ON "files"("repo_id", "path");

-- CreateIndex
CREATE INDEX "symbols_name_idx" ON "symbols"("name");

-- CreateIndex
CREATE UNIQUE INDEX "symbols_file_id_local_index_key" ON "symbols"("file_id", "local_index");

-- CreateIndex
CREATE INDEX "edges_repo_id_idx" ON "edges"("repo_id");

-- CreateIndex
CREATE INDEX "edges_src_symbol_id_idx" ON "edges"("src_symbol_id");

-- CreateIndex
CREATE INDEX "edges_dst_symbol_id_idx" ON "edges"("dst_symbol_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_symbol_id_fkey" FOREIGN KEY ("src_symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_symbol_id_fkey" FOREIGN KEY ("dst_symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
