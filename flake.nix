{
  description = "DOP-C02 study lab dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # AWS
            awscli2
            aws-sam-cli
            ssm-session-manager-plugin

            # Node.js
            nodejs_22

            # Python
            python312
            python312Packages.pip

            # Containers
            docker

            # General
            git
            jq
            zip
            unzip
            curl
            wget
          ];

          shellHook = ''
            export AWS_PROFILE=hector-experiments
            export AWS_DEFAULT_OUTPUT=json

            # Install AWS CDK globally via npm if not present
            export NPM_CONFIG_PREFIX="$PWD/.npm-global"
            export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
            if ! command -v cdk &> /dev/null; then
              echo "Installing AWS CDK CLI..."
              npm install -g aws-cdk --silent 2>/dev/null
            fi

            echo ""
            echo "🔧 DOP-C02 Study Lab Environment"
            echo "   AWS Profile: $AWS_PROFILE"
            echo "   Node:        $(node --version)"
            echo "   Python:      $(python3 --version 2>&1 | cut -d' ' -f2)"
            echo "   AWS CLI:     $(aws --version 2>&1 | cut -d' ' -f1 | cut -d'/' -f2)"
            echo "   SAM CLI:     $(sam --version 2>&1 | cut -d' ' -f4)"
            echo "   CDK:         $(cdk --version 2>&1 | cut -d' ' -f1)"
            echo ""
          '';
        };
      });
}
