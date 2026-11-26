-- CreateTable
CREATE TABLE "stored_files" (
    "key" VARCHAR(255) NOT NULL,
    "contentType" VARCHAR(60) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("key")
);
