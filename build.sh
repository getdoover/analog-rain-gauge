#!/bin/sh
# Package the lambda-deployed processor app(s) in this repo (e.g. the Rainfall
# Dashboard) into package.zip — vendored dependencies + the `src` tree. The
# container-deployed Analog Rain Gauge app uses the Dockerfile instead; this is
# only for the PRO lambda app(s).

uv export --frozen --no-dev --no-editable --quiet -o requirements.txt

uv pip install \
   --no-deps \
   --no-installer-metadata \
   --no-compile-bytecode \
   --python-platform x86_64-manylinux2014 \
   --python 3.13 \
   --quiet \
   --target packages_export \
   --refresh \
   -r requirements.txt

rm -f package.zip

cd packages_export
zip -rq ../package.zip .
cd ..

zip -rq package.zip src

echo "OK"
