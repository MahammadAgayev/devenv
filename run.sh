#!/bin/bash

curl https://raw.githubusercontent.com/MahammadAgayev/devenv/refs/heads/main/configure.yml -o configure.yml && ansible-playbook configure.yml
