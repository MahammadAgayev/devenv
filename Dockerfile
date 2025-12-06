FROM debian:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y software-properties-common zsh sudo && \
    apt-add-repository 'deb http://deb.debian.org/debian/ bullseye-backports main' && \
    apt-get update && \
    apt-get install -y ansible

# Create user with home directory and full sudo access
RUN useradd -m -s /bin/zsh -d /home/user user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Switch to user
USER user
WORKDIR /home/user

# Copy configure.yml
COPY --chown=user:user configure.yml /home/user/configure.yml

# Run ansible playbook as user
RUN ansible-playbook -v /home/user/configure.yml

CMD ["/bin/zsh"]
