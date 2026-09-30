# Postgres with pgvector, built on the same Alpine image the stack already ran.
#
# Not pgvector/pgvector: that image is Debian (glibc), and swapping the C library
# under an existing data directory changes how text collates, which silently
# corrupts any index over text. Compiling the extension here keeps the base -
# and the data volume - exactly as they were.
#
# with_llvm=no skips the JIT bitcode, which would need the clang release the
# server itself was built with; OPTFLAGS="" avoids -march=native, so the image
# runs on any x86-64 machine rather than only the one that built it.
FROM postgres:16-alpine

ARG PGVECTOR_VERSION=v0.8.0

RUN apk add --no-cache --virtual .build-deps git build-base \
 && git clone --branch "${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
 && make -C /tmp/pgvector with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del .build-deps
