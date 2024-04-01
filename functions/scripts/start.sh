#!/bin/bash

# http://redsymbol.net/articles/unofficial-bash-strict-mode/
set -euo pipefail
IFS=$'\n\t'

export \
    AWS_REGION=eu-west-2 \
    AWS_PROFILE=default

npx tsc
node build