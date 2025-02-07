FROM debian:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y software-properties-common zsh && \
    apt-add-repository 'deb http://deb.debian.org/debian/ bullseye-backports main' && \
    apt-get update && \
    apt-get install -y ansible

COPY configure.yml /etc/ansible/configure.yml

RUN ansible-playbook -v /etc/ansible/configure.yml

CMD ["/bin/zsh"]
