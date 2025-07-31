#!/bin/env bash

curl -X POST -H "Authorization: Bearer ${ADMIN_TOKEN}" https://actions-public-oidc.depot.dev/-/generate-key
