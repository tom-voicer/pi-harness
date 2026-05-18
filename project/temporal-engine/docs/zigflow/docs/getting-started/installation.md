# Installation | Zigflow

> Source: [https://zigflow.dev/docs/getting-started/installation](https://zigflow.dev/docs/getting-started/installation)

Zigflow is a single Go binary with prebuilt options.

## What you will learn[​](#what-you-will-learn "Direct link to What you will learn")

*   How to install the Zigflow binary on your platform
*   How to run Zigflow from a Docker image
*   How to install from source

## Homebrew[​](#homebrew "Direct link to Homebrew")

Install Zigflow using Homebrew:

```
brew tap zigflow/tapbrew install --cask zigflow
```

Verify the installation:

```
zigflow version
```

If you prefer not to use Homebrew, download binaries from [GitHub Releases](https://github.com/zigflow/zigflow/releases).

## Binary Releases[​](#binary-releases "Direct link to Binary Releases")

Every [release](https://github.com/zigflow/zigflow/releases) of Zigflow provides binary releases for a variety of OSes. These binary versions can be manually downloaded and installed.

1.  Download your [desired version](https://github.com/zigflow/zigflow/releases)
2.  Make it executable `chmod +x ./path/to/binary`
3.  (Optional) Move to your `$PATH` directory

## Docker Image[​](#docker-image "Direct link to Docker Image")

Every [release](https://github.com/zigflow/zigflow/pkgs/container/zigflow) of Zigflow provides a Docker image. The binary is set as the [entrypoint](https://docs.docker.com/reference/dockerfile/#entrypoint), so you can use the image as a replacement for the binary.

A `latest` tag is maintained for the most recent tag, or you can use the version as the tag (eg, `0.1.0`).

```
docker run -it --rm \  -v /path/to/workflow.yaml:/app/workflow.yaml \  ghcr.io/zigflow/zigflow \  run
```

## Go Install[​](#go-install "Direct link to Go Install")

If you already have [Go](https://go.dev/doc/install) installed, you can use the Go package manager to install the binary. This will be installed under your `$GOPATH`.

```
go install github.com/zigflow/zigflow@latest
```

You can specify a version by changing `@latest` to the desired version.

### From Source[​](#from-source "Direct link to From Source")

tip

You will need to install [Go](https://go.dev/doc/install)

Building from source is useful for testing unreleased versions.

```
git clone https://github.com/zigflow/zigflow.gitcd zigflowgo build .
```

This will fetch the dependencies and build the binary. It will compile it to `./zigflow`.